use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::Response,
};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::{
    api::middleware::{verify_token, Claims},
    app_state::AppState,
    gateway::realtime::frame::WireFrame,
};

// ── 关闭码 ────────────────────────────────────────────────────────────────────
const CLOSE_AUTH_FAIL: u16 = 4401;
const CLOSE_NOT_MEMBER: u16 = 4403;
const CLOSE_BACKPRESSURE: u16 = 4408;

/// 鉴权超时：10 秒内未收到合法 auth 帧则关闭。
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);

/// 每条连接的发送队列容量。
/// 终态帧队列满时关闭连接（写后投递：宁可断线也不丢终态帧）。
const SEND_QUEUE_SIZE: usize = 256;

// ── 控制帧格式（客户端 → Backend）────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientFrame {
    Auth { token: String },
    Subscribe { channel_id: Uuid },
    Unsubscribe { channel_id: Uuid },
    Ping,
}

// ── 服务端控制回执（Backend → 客户端）────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerControl {
    AuthOk { user_id: Uuid },
    AuthErr { reason: String },
    Subscribed { channel_id: Uuid },
    Unsubscribed { channel_id: Uuid },
    Pong,
    Error { detail: String },
}

// ── Axum upgrade handler ──────────────────────────────────────────────────────

/// axum 路由挂载：`Router::new().route("/ws", get(ws_handler))`
pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

// ── 连接主循环 ────────────────────────────────────────────────────────────────

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    // ── 阶段 1：鉴权（10s 超时）─────────────────────────────────────────────
    let claims = match auth_phase(&mut socket, &state).await {
        Some(c) => c,
        None => return, // 超时或鉴权失败，连接已关闭
    };

    let user_id: Uuid = match claims.sub.parse() {
        Ok(id) => id,
        Err(_) => {
            close(&mut socket, CLOSE_AUTH_FAIL, "invalid user_id in token").await;
            return;
        }
    };

    // ── 阶段 2：建立发送队列 + 注册连接 ──────────────────────────────────────
    let conn_id = Uuid::new_v4();
    let (tx, mut rx) = mpsc::channel::<WireFrame>(SEND_QUEUE_SIZE);
    // 背压关闭信号：终态帧入队失败时由 fan-out 触发（I6，R3）。容量 1 即可——
    // 一次信号就足以关连接，重复信号忽略。
    let (close_tx, mut close_rx) = mpsc::channel::<()>(1);

    state
        .conn_manager
        .on_connect(user_id, conn_id, tx.clone(), close_tx);
    send_control(&mut socket, &ServerControl::AuthOk { user_id }).await;

    // ── 阶段 3：双向读写循环 ───────────────────────────────────────────────
    let mut subscribed: Vec<Uuid> = Vec::new();

    loop {
        tokio::select! {
            // 收客户端帧
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_client_frame(
                            &text,
                            user_id,
                            conn_id,
                            &tx,
                            &mut subscribed,
                            &mut socket,
                            &state,
                        ).await;
                    }
                    Some(Ok(Message::Ping(data))) => {
                        let _ = socket.send(Message::Pong(data)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }

            // 从 fan-out 队列接收帧，发给客户端
            frame = rx.recv() => {
                match frame {
                    Some(f) => {
                        let is_terminal = is_terminal_frame(&f);
                        let json = match serde_json::to_string(&f) {
                            Ok(s) => s,
                            Err(_) => continue,
                        };

                        if socket.send(Message::Text(json)).await.is_err() {
                            if is_terminal {
                                // 终态帧发送失败 → 背压关闭（写后投递原则：不丢终态帧）
                                close(&mut socket, CLOSE_BACKPRESSURE, "send queue full").await;
                            }
                            break;
                        }
                    }
                    None => break,
                }
            }

            // fan-out 报告终态帧入队失败（背压）→ 关闭连接，客户端走 REST 补齐（I6）。
            _ = close_rx.recv() => {
                close(&mut socket, CLOSE_BACKPRESSURE, "send queue full").await;
                break;
            }
        }
    }

    // ── 清理 ──────────────────────────────────────────────────────────────────
    state
        .conn_manager
        .on_disconnect(user_id, conn_id, &subscribed);
    for channel_id in &subscribed {
        broadcast_presence(&state, *channel_id).await;
    }
}

/// 计算频道当前在线用户并广播 presence 帧（订阅/退订/断线时触发）。
/// presence 非终态帧，队列满时可丢弃——下次变更会再发一次全量。
async fn broadcast_presence(state: &AppState, channel_id: Uuid) {
    let user_ids = state.fanout.online_users(channel_id);
    let frame = WireFrame::channel(
        channel_id,
        "presence",
        serde_json::json!({
            "channel_id": channel_id,
            "online_user_ids": user_ids,
            "count": user_ids.len(),
        }),
    );
    state.fanout.broadcast_channel(channel_id, frame).await;
}

// ── 鉴权阶段 ─────────────────────────────────────────────────────────────────

async fn auth_phase(socket: &mut WebSocket, state: &AppState) -> Option<Claims> {
    let deadline = tokio::time::sleep(AUTH_TIMEOUT);
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            _ = &mut deadline => {
                close(socket, CLOSE_AUTH_FAIL, "auth timeout").await;
                return None;
            }
            msg = socket.recv() => {
                let text = match msg {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Ping(d))) => {
                        let _ = socket.send(Message::Pong(d)).await;
                        continue;
                    }
                    _ => return None,
                };

                let frame: ClientFrame = match serde_json::from_str(&text) {
                    Ok(f) => f,
                    Err(_) => {
                        send_control(socket, &ServerControl::Error {
                            detail: "invalid JSON".into(),
                        }).await;
                        continue;
                    }
                };

                match frame {
                    ClientFrame::Auth { token } => {
                        match verify_token(&token, state) {
                            Ok(claims) => return Some(claims),
                            Err(reason) => {
                                send_control(socket, &ServerControl::AuthErr {
                                    reason: reason.to_string(),
                                }).await;
                                close(socket, CLOSE_AUTH_FAIL, "auth failed").await;
                                return None;
                            }
                        }
                    }
                    _ => {
                        send_control(socket, &ServerControl::Error {
                            detail: "send auth frame first".into(),
                        }).await;
                    }
                }
            }
        }
    }
}

// ── 客户端帧处理 ──────────────────────────────────────────────────────────────

async fn handle_client_frame(
    text: &str,
    user_id: Uuid,
    conn_id: Uuid,
    tx: &mpsc::Sender<WireFrame>,
    subscribed: &mut Vec<Uuid>,
    socket: &mut WebSocket,
    state: &AppState,
) {
    let frame: ClientFrame = match serde_json::from_str(text) {
        Ok(f) => f,
        Err(_) => {
            send_control(
                socket,
                &ServerControl::Error {
                    detail: "invalid JSON".into(),
                },
            )
            .await;
            return;
        }
    };

    match frame {
        ClientFrame::Auth { token } => {
            // AUTHED 状态下再次收到 auth → token 续期
            match verify_token(&token, state) {
                Ok(_) => {
                    send_control(socket, &ServerControl::AuthOk { user_id }).await;
                }
                Err(e) => {
                    send_control(
                        socket,
                        &ServerControl::AuthErr {
                            reason: e.to_string(),
                        },
                    )
                    .await;
                }
            }
        }

        ClientFrame::Subscribe { channel_id } => {
            if subscribed.contains(&channel_id) {
                // 已订阅，直接回执（幂等）
                send_control(socket, &ServerControl::Subscribed { channel_id }).await;
                return;
            }

            match state
                .conn_manager
                .subscribe(user_id, conn_id, channel_id, tx.clone())
                .await
            {
                Ok(()) => {
                    subscribed.push(channel_id);
                    send_control(socket, &ServerControl::Subscribed { channel_id }).await;
                    broadcast_presence(state, channel_id).await;
                }
                Err(_) => {
                    close(socket, CLOSE_NOT_MEMBER, "not a channel member").await;
                }
            }
        }

        ClientFrame::Unsubscribe { channel_id } => {
            state.conn_manager.unsubscribe(conn_id, channel_id);
            subscribed.retain(|&id| id != channel_id);
            send_control(socket, &ServerControl::Unsubscribed { channel_id }).await;
            broadcast_presence(state, channel_id).await;
        }

        ClientFrame::Ping => {
            send_control(socket, &ServerControl::Pong).await;
        }
    }
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/// 终态帧：队列满时不丢，关闭连接（写后投递原则）。见 `WireFrame::is_terminal`。
fn is_terminal_frame(frame: &WireFrame) -> bool {
    frame.is_terminal()
}

async fn send_control(socket: &mut WebSocket, ctrl: &ServerControl) {
    if let Ok(json) = serde_json::to_string(ctrl) {
        let _ = socket.send(Message::Text(json)).await;
    }
}

async fn close(socket: &mut WebSocket, code: u16, reason: &str) {
    let _ = socket
        .send(Message::Close(Some(axum::extract::ws::CloseFrame {
            code,
            reason: reason.to_string().into(),
        })))
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::realtime::frame::WireFrame;
    use serde_json::json;

    fn frame(frame_type: &str) -> WireFrame {
        WireFrame::channel(Uuid::new_v4(), frame_type, json!({}))
    }

    /// I6：终态帧（不可丢，背压时关连接）须被识别。
    #[test]
    fn terminal_frames_are_recognized() {
        for ft in ["message", "message_done", "message_deleted"] {
            assert!(is_terminal_frame(&frame(ft)), "{ft} 是终态帧");
        }
    }

    /// 流式 / 其它帧不是终态帧（背压时可静默丢弃）。
    #[test]
    fn streaming_frames_are_not_terminal() {
        for ft in ["message_stream", "bot_trace", "pong", "presence"] {
            assert!(!is_terminal_frame(&frame(ft)), "{ft} 不是终态帧");
        }
    }
}

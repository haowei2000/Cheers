use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::{
    api::middleware::{verify_token, Claims},
    app_state::AppState,
    gateway::realtime::{fanout::CloseReason, frame::WireFrame},
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
    Auth {
        token: String,
    },
    Subscribe {
        channel_id: Uuid,
    },
    Unsubscribe {
        channel_id: Uuid,
    },
    Ping,
    /// 工作台：浏览器对平台 fs/channel 资源的 req/res 请求（经 `resource::dispatch_user`）。
    /// 回执是 `resource_res` 原始帧（按 `req_id` 关联），直接写回本连接 socket。
    ResourceReq {
        req_id: String,
        resource: String,
        #[serde(default)]
        params: serde_json::Value,
    },
    /// 工作台在看焦点：本连接正在查看某 bot 的工作区（可含路径）。
    /// `focus: null` 表示清除。焦点随 `presence` 全量快照下发给频道其他成员。
    /// 仅对本连接已订阅的频道生效；断线自动清除。
    PresenceFocus {
        channel_id: Uuid,
        focus: Option<FocusPayload>,
    },
}

/// `presence_focus` 帧里的焦点载荷。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct FocusPayload {
    bot_id: Uuid,
    #[serde(default)]
    path: Option<String>,
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
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    // CSWSH guard: reject browser upgrades from non-allowlisted origins before
    // upgrading. Native clients send no Origin and fall through to token auth.
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    if !crate::infra::http::ws_origin_allowed(origin, &state.config.allowed_origins()) {
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
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
    // 服务端关闭信号：背压（终态帧入队失败，I6/R3）或会话吊销（kick_user）时由
    // fan-out 触发。容量 1 即可——一次信号就足以关连接，重复信号忽略。
    let (close_tx, mut close_rx) = mpsc::channel::<CloseReason>(1);

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
                        let keep_open = handle_client_frame(
                            &text,
                            user_id,
                            conn_id,
                            &tx,
                            &mut subscribed,
                            &mut socket,
                            &state,
                        ).await;
                        if !keep_open {
                            break;
                        }
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

            // fan-out 的服务端关闭信号：背压（I6，客户端走 REST 补齐）或
            // 会话吊销（logout/改密/封禁 → kick_user，客户端须重新登录）。
            reason = close_rx.recv() => {
                match reason {
                    Some(CloseReason::Revoked) => {
                        close(&mut socket, CLOSE_AUTH_FAIL, "session revoked").await;
                    }
                    _ => {
                        close(&mut socket, CLOSE_BACKPRESSURE, "send queue full").await;
                    }
                }
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

/// presence 帧广播（订阅/退订/断线时触发）——统一实现见 gateway::presence，
/// 名单同时包含在线用户与在线 bot。
async fn broadcast_presence(state: &AppState, channel_id: Uuid) {
    crate::gateway::presence::broadcast_presence(state, channel_id).await;
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
                        // 与 HTTP 中间件同一套校验：验签 + DB 吊销检查（token_version /
                        // is_suspended / is_deleted），登出/封禁用户拿旧 JWT 连不上。
                        match verify_token(&token, state).await {
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

/// Handle one client frame. Returns `false` when the server has sent a Close
/// frame and the connection loop must terminate (auth revoked mid-connection,
/// or a subscribe by a non-member); `true` keeps the connection open.
async fn handle_client_frame(
    text: &str,
    user_id: Uuid,
    conn_id: Uuid,
    tx: &mpsc::Sender<WireFrame>,
    subscribed: &mut Vec<Uuid>,
    socket: &mut WebSocket,
    state: &AppState,
) -> bool {
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
            return true;
        }
    };

    match frame {
        ClientFrame::Auth { token } => {
            // AUTHED 状态下再次收到 auth → token 续期（同样做 DB 吊销检查）。
            // 续期失败即关闭：客户端递上来的就是「此会话已吊销」的证明，绝不能
            // 只回 AuthErr 而让旧 socket 连同其订阅继续存活（覆盖没有走
            // kick_user 的吊销路径，例如运维直接改库 bump token_version）。
            match verify_token(&token, state).await {
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
                    close(socket, CLOSE_AUTH_FAIL, "auth failed").await;
                    return false;
                }
            }
        }

        ClientFrame::Subscribe { channel_id } => {
            if subscribed.contains(&channel_id) {
                // 已订阅，直接回执（幂等）
                send_control(socket, &ServerControl::Subscribed { channel_id }).await;
                return true;
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
                    return false;
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

        ClientFrame::PresenceFocus { channel_id, focus } => {
            // 只对已订阅的频道生效——否则忽略（不能对未加入的频道声明在看态）。
            if !subscribed.contains(&channel_id) {
                return true;
            }
            match focus {
                Some(f) => state
                    .fanout
                    .set_focus(conn_id, channel_id, f.bot_id, f.path),
                None => state.fanout.clear_focus(conn_id),
            }
            broadcast_presence(state, channel_id).await;
        }

        ClientFrame::ResourceReq {
            req_id,
            resource,
            params,
        } => {
            // 用户路径：channel-role 鉴权在 dispatch_user 内（含破坏性 rm/mv 限 owner/admin）。
            let frame = serde_json::json!({
                "req_id": req_id,
                "resource": resource,
                "params": params,
            });
            let res = crate::resource::dispatch_user(&state.db, user_id, &frame).await;
            // Live Desk (browser path): mirror the bot-side board_signal tick in
            // agent_bridge.rs so a human's own Desk edit refreshes other open views.
            // resource::dispatch_user only holds `db`, so the fanout tick is emitted
            // here at the WS boundary. Data-free — clients re-pull via their own
            // authz'd fs.ls/fs.read. board name "files" (cross-slice contract).
            if matches!(
                frame.get("resource").and_then(serde_json::Value::as_str),
                Some("fs.write" | "fs.edit" | "fs.append" | "fs.rm" | "fs.mv")
            ) && res.get("ok").and_then(serde_json::Value::as_bool) == Some(true)
            {
                if let Some(cid) = res
                    .get("data")
                    .and_then(|d| d.get("channel_id"))
                    .and_then(serde_json::Value::as_str)
                    .and_then(|s| s.parse::<Uuid>().ok())
                {
                    let wire = WireFrame::channel(
                        cid,
                        "board_signal",
                        serde_json::json!({ "channel_id": cid, "board": "files" }),
                    );
                    state.fanout.broadcast_channel(cid, wire).await;
                }
            }
            if let Ok(json) = serde_json::to_string(&res) {
                let _ = socket.send(Message::Text(json)).await;
            }
        }
    }
    true
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
        for ft in ["message", "message_done", "message_deleted", "bot_unavailable"] {
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

    /// 工作台帧线格式：`{type:"resource_req", req_id, resource, params}` 必须
    /// 反序列化进 `ClientFrame::ResourceReq`（serde tag/rename 接线正确）。
    #[test]
    fn resource_req_frame_deserializes() {
        let raw = r#"{"type":"resource_req","req_id":"r1","resource":"fs.ls","params":{"channel_id":"c","path":"notes"}}"#;
        let frame: ClientFrame = serde_json::from_str(raw).unwrap();
        match frame {
            ClientFrame::ResourceReq {
                req_id,
                resource,
                params,
            } => {
                assert_eq!(req_id, "r1");
                assert_eq!(resource, "fs.ls");
                assert_eq!(params["channel_id"], "c");
                assert_eq!(params["path"], "notes");
            }
            _ => panic!("expected ResourceReq"),
        }
    }

    /// 缺省 params 也能反序列化（`#[serde(default)]`）。
    #[test]
    fn resource_req_without_params_defaults() {
        let raw = r#"{"type":"resource_req","req_id":"r2","resource":"fs.ls"}"#;
        let frame: ClientFrame = serde_json::from_str(raw).unwrap();
        assert!(matches!(frame, ClientFrame::ResourceReq { .. }));
    }

    /// presence_focus 帧（带焦点）反序列化：bot_id + path 正确落入 FocusPayload。
    #[test]
    fn presence_focus_with_focus_deserializes() {
        let cid = Uuid::new_v4();
        let bid = Uuid::new_v4();
        let raw = format!(
            r#"{{"type":"presence_focus","channel_id":"{cid}","focus":{{"bot_id":"{bid}","path":"src/main.rs"}}}}"#
        );
        let frame: ClientFrame = serde_json::from_str(&raw).unwrap();
        match frame {
            ClientFrame::PresenceFocus { channel_id, focus } => {
                assert_eq!(channel_id, cid);
                let f = focus.expect("focus present");
                assert_eq!(f.bot_id, bid);
                assert_eq!(f.path.as_deref(), Some("src/main.rs"));
            }
            _ => panic!("expected PresenceFocus"),
        }
    }

    /// presence_focus 帧（focus:null）反序列化为清除意图。
    #[test]
    fn presence_focus_null_clears() {
        let cid = Uuid::new_v4();
        let raw = format!(r#"{{"type":"presence_focus","channel_id":"{cid}","focus":null}}"#);
        let frame: ClientFrame = serde_json::from_str(&raw).unwrap();
        match frame {
            ClientFrame::PresenceFocus { channel_id, focus } => {
                assert_eq!(channel_id, cid);
                assert!(focus.is_none());
            }
            _ => panic!("expected PresenceFocus"),
        }
    }

    /// presence_focus 帧省略 path 时 path 为 None（`#[serde(default)]`）。
    #[test]
    fn presence_focus_without_path_defaults_none() {
        let cid = Uuid::new_v4();
        let bid = Uuid::new_v4();
        let raw = format!(
            r#"{{"type":"presence_focus","channel_id":"{cid}","focus":{{"bot_id":"{bid}"}}}}"#
        );
        let frame: ClientFrame = serde_json::from_str(&raw).unwrap();
        match frame {
            ClientFrame::PresenceFocus { focus, .. } => {
                assert!(focus.unwrap().path.is_none());
            }
            _ => panic!("expected PresenceFocus"),
        }
    }
}

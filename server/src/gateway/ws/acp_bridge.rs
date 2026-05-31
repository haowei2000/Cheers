/// ACP Bridge WebSocket 处理器。
///
/// 两个端点：
///   /ws/acp-bridge/control  —— 生命周期、task 派发
///   /ws/acp-bridge/data     —— delta/done/resource_req 等数据帧
use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::Response,
};
use serde_json::{json, Value};
use sqlx::Row;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::{
    app_state::AppState,
    gateway::stream::{handle_delta, handle_done, handle_send},
    infra::crypto::hash_bot_token,
    resource,
};
use sqlx::PgPool;

// ── 关闭码（与 WIRE_PROTOCOL 对齐）──────────────────────────────────────────
const CLOSE_AUTH_FAIL: u16 = 4401;
const CLOSE_BOT_UNAVAILABLE: u16 = 4403;
const CLOSE_SUPERSEDED: u16 = 4402;

/// bot 连接的元信息（从 DB 查出来后到处用）。
#[derive(Debug, Clone)]
struct BotInfo {
    bot_id: Uuid,
    username: String,
    display_name: Option<String>,
}

// ── Control WS ────────────────────────────────────────────────────────────────

/// GET /ws/acp-bridge/control
pub async fn control_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Response {
    ws.on_upgrade(move |socket| handle_control(socket, state))
}

async fn handle_control(mut socket: WebSocket, state: AppState) {
    // ── 1. 从 URL query 或 header 提取 botToken ───────────────────────────
    // axum WebSocketUpgrade 已完成 HTTP 握手，token 从第一帧取（或可从 header 取）
    // 这里简化：从 hello 第一帧的 token 字段取（connector 发的首帧）
    let bot = match auth_bot_from_first_frame(&mut socket, &state).await {
        Some(b) => b,
        None => return,
    };

    // ── 2. 注册 control 连接（supersede 旧连接）────────────────────────────
    let connection_id = Uuid::new_v4();
    let (task_tx, mut task_rx) = mpsc::channel::<Value>(64);

    state.bot_registry.bind_control(bot.bot_id, connection_id, task_tx);

    // ── 3. 发 hello 帧（membership snapshot）─────────────────────────────
    let memberships = load_memberships(&state.db, bot.bot_id).await;
    let hello = json!({
        "type": "hello",
        "bot_id": bot.bot_id,
        "bot_username": bot.username,
        "bot_display_name": bot.display_name,
        "connection_id": connection_id,
        "memberships": memberships,
    });
    if ws_send(&mut socket, &hello).await.is_err() {
        return;
    }

    tracing::info!(bot_id = %bot.bot_id, "control connected");

    // ── 4. 双向读写循环 ───────────────────────────────────────────────────
    loop {
        tokio::select! {
            // 收 bot 发来的控制帧
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                            handle_control_frame(&frame, &state, bot.bot_id).await;
                        }
                    }
                    Some(Ok(Message::Ping(d))) => { let _ = socket.send(Message::Pong(d)).await; }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }

            // 收 dispatcher 发来的 task 帧，转发给 bot
            task = task_rx.recv() => {
                match task {
                    Some(t) => {
                        if ws_send(&mut socket, &t).await.is_err() { break; }
                    }
                    None => break,
                }
            }
        }
    }

    tracing::info!(bot_id = %bot.bot_id, "control disconnected");
    // TODO: unbind control
}

async fn handle_control_frame(frame: &Value, state: &AppState, bot_id: Uuid) {
    let ftype = frame.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match ftype {
        "ping" => {} // pong 由 WS 层处理
        "ready" => {
            tracing::info!(bot_id = %bot_id, version = ?frame.get("plugin_version"), "bot ready");
        }
        "config_status" | "config_options" | "config_option_status" => {
            // TODO: 持久化 config 状态到 bot_accounts.binding_config
        }
        other => {
            tracing::debug!(bot_id = %bot_id, frame_type = other, "unknown control frame");
        }
    }
}

// ── Data WS ───────────────────────────────────────────────────────────────────

/// GET /ws/acp-bridge/data
pub async fn data_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Response {
    ws.on_upgrade(move |socket| handle_data(socket, state))
}

async fn handle_data(mut socket: WebSocket, state: AppState) {
    // ── 1. 鉴权 ──────────────────────────────────────────────────────────
    let bot = match auth_bot_from_first_frame(&mut socket, &state).await {
        Some(b) => b,
        None => return,
    };

    // ── 2. 注册 data 连接 ────────────────────────────────────────────────
    let connection_id = Uuid::new_v4();
    let (res_tx, mut res_rx) = mpsc::channel::<Value>(128);

    state.bot_registry.bind_data(bot.bot_id, res_tx);

    // ── 3. 发 hello 帧 ──────────────────────────────────────────────────
    // last_event_seq: 最后一次事件的 seq（重连重放用，暂返回 0）
    let hello = json!({
        "type": "hello",
        "stream": "data",
        "bot_id": bot.bot_id,
        "connection_id": connection_id,
        "last_event_seq": 0,
    });
    if ws_send(&mut socket, &hello).await.is_err() {
        return;
    }

    tracing::info!(bot_id = %bot.bot_id, "data connected");

    // ── 4. 双向读写循环 ───────────────────────────────────────────────────
    loop {
        tokio::select! {
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                            handle_data_frame(&frame, &state, &bot, &mut socket).await;
                        }
                    }
                    Some(Ok(Message::Ping(d))) => { let _ = socket.send(Message::Pong(d)).await; }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }

            // Backend 发给 bot 的帧（resource_res、permission_request 等）
            outbound = res_rx.recv() => {
                match outbound {
                    Some(frame) => {
                        if ws_send(&mut socket, &frame).await.is_err() { break; }
                    }
                    None => break,
                }
            }
        }
    }

    tracing::info!(bot_id = %bot.bot_id, "data disconnected");
}

async fn handle_data_frame(
    frame: &Value,
    state: &AppState,
    bot: &BotInfo,
    socket: &mut WebSocket,
) {
    let ftype = frame.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match ftype {
        // ── 流式输出（写后投递）────────────────────────────────────────────
        "delta" => {
            if let Err(e) = handle_delta(
                &state.stream_registry,
                &state.fanout,
                &state.db,
                bot.bot_id,
                frame,
            )
            .await
            {
                tracing::warn!(bot_id = %bot.bot_id, err = e, "delta rejected");
                let _ = ws_send(socket, &json!({ "type": "error", "detail": e })).await;
            }
        }

        "done" => {
            if let Err(e) = handle_done(
                &state.stream_registry,
                &state.fanout,
                &state.db,
                bot.bot_id,
                frame,
            )
            .await
            {
                tracing::warn!(bot_id = %bot.bot_id, err = e, "done rejected");
            }
        }

        // ── bot 主动发新消息 ───────────────────────────────────────────────
        "send" => {
            if let Err(e) = handle_send(&state.fanout, &state.db, bot.bot_id, frame).await {
                tracing::warn!(bot_id = %bot.bot_id, err = e, "send failed");
            }
        }

        // ── resource 访问 ──────────────────────────────────────────────────
        "resource_req" => {
            let resp = resource::dispatch(&state.db, bot.bot_id, frame).await;
            // resource_res 发回给 bot（通过同一条 data WS）
            let _ = ws_send(socket, &resp).await;
        }

        // ── 审批请求（转发给频道内用户）─────────────────────────────────────
        "permission_request" => {
            // TODO: fan-out permission_request 帧给频道内用户
        }

        "ping" => {
            let _ = ws_send(socket, &json!({ "type": "pong" })).await;
        }

        "resume" => {
            // TODO: event_log 重放
        }

        other => {
            tracing::debug!(bot_id = %bot.bot_id, frame_type = other, "unknown data frame");
        }
    }
}

// ── 鉴权：从首帧取 botToken ────────────────────────────────────────────────────
//
// ACP Bridge 的鉴权方式：connector 建立 WS 后发第一帧
// { "type": "auth", "token": "agb_xxx" }
// Backend 查 bot_accounts.bot_token_hash，匹配则接受连接。
//
// 注意：也支持 HTTP header Authorization: Bearer agb_xxx（由 axum 在 upgrade 时读取，
// 但 WebSocketUpgrade extractor 暂不直接暴露 headers，所以统一用首帧方式）。

async fn auth_bot_from_first_frame(
    socket: &mut WebSocket,
    state: &AppState,
) -> Option<BotInfo> {
    use tokio::time::{sleep, Duration};

    let timeout = sleep(Duration::from_secs(10));
    tokio::pin!(timeout);

    loop {
        tokio::select! {
            _ = &mut timeout => {
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

                let frame: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                let token = match frame.get("token").and_then(|v| v.as_str()) {
                    Some(t) => t.to_string(),
                    None => continue,
                };

                match resolve_bot(&state.db, &token).await {
                    Some(bot) => return Some(bot),
                    None => {
                        close(socket, CLOSE_AUTH_FAIL, "invalid or revoked token").await;
                        return None;
                    }
                }
            }
        }
    }
}

/// 通过 botToken 查找并验证 bot。
async fn resolve_bot(db: &PgPool, token: &str) -> Option<BotInfo> {
    let token_hash = hash_bot_token(token);

    let row = sqlx::query(
        "SELECT id, username, display_name, status
         FROM bot_accounts WHERE bot_token_hash = $1",
    )
    .bind(&token_hash)
    .fetch_optional(db)
    .await
    .ok()??;

    let status: String = row.try_get("status").unwrap_or_default();
    if status != "online" {
        return None;
    }

    let bot_id_str: String = row.try_get("id").ok()?;
    Some(BotInfo {
        bot_id: bot_id_str.parse().ok()?,
        username: row.try_get("username").unwrap_or_default(),
        display_name: row.try_get("display_name").ok(),
    })
}

async fn load_memberships(db: &PgPool, bot_id: Uuid) -> Vec<Value> {
    let rows = sqlx::query(
        "SELECT cm.channel_id, c.name
         FROM channel_memberships cm
         JOIN channels c ON c.id = cm.channel_id
         WHERE cm.member_id = $1 AND cm.member_type = 'bot'",
    )
    .bind(bot_id.to_string())
    .fetch_all(db)
    .await
    .unwrap_or_default();

    rows.iter()
        .map(|r| {
            json!({
                "channel_id": r.try_get::<String, _>("channel_id").unwrap_or_default(),
                "channel_name": r.try_get::<String, _>("name").unwrap_or_default(),
            })
        })
        .collect()
}

// ── 辅助 ──────────────────────────────────────────────────────────────────────

async fn ws_send(socket: &mut WebSocket, value: &Value) -> Result<(), ()> {
    let json = serde_json::to_string(value).map_err(|_| ())?;
    socket.send(Message::Text(json)).await.map_err(|_| ())
}

async fn close(socket: &mut WebSocket, code: u16, reason: &str) {
    let _ = socket
        .send(Message::Close(Some(axum::extract::ws::CloseFrame {
            code,
            reason: reason.to_string().into(),
        })))
        .await;
}

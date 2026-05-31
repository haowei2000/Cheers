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
    domain::acp_capability,
    gateway::stream::{handle_delta, handle_done, handle_send, handle_session_update},
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
    provider_account_id: String,
    username: String,
    display_name: Option<String>,
    require_capability: bool,
    /// 可选的 ACP 安全配置快照（目前仅回显，不强制加解密）。
    acp_security: Option<Value>,
}

// ── Control WS ────────────────────────────────────────────────────────────────

/// GET /ws/acp-bridge/control
pub async fn control_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
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

    state
        .bot_registry
        .bind_control(bot.bot_id, connection_id, task_tx);

    // ── 3. 发 hello 帧（membership snapshot）─────────────────────────────
    let memberships = load_memberships(&state.db, bot.bot_id).await;
    let mut hello = json!({
        "type": "hello",
        "bot_id": bot.bot_id,
        "bot_username": bot.username,
        "bot_display_name": bot.display_name,
        "connection_id": connection_id,
        "session_id": connection_id,
        "memberships": memberships,
    });
    if let Some(acp_security) = &bot.acp_security {
        hello["acp_security"] = acp_security.clone();
    }
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
pub async fn data_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
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
    let mut hello = json!({
        "type": "hello",
        "stream": "data",
        "bot_id": bot.bot_id,
        "connection_id": connection_id,
        "session_id": connection_id,
        "last_event_seq": 0,
    });
    if let Some(acp_security) = &bot.acp_security {
        hello["acp_security"] = acp_security.clone();
    }
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
                            if bot.require_capability {
                                if let Err(err) =
                                    acp_capability::authorize_data_frame(
                                        &state.db,
                                        &bot.bot_id,
                                        &bot.provider_account_id,
                                        &frame,
                                    )
                                        .await
                                {
                                    let frame_type = frame
                                        .get("type")
                                        .and_then(Value::as_str)
                                        .unwrap_or("unknown");
                                    let decision_context = err.decision_context();
                                    let action = decision_context.map(|ctx| ctx.action.as_str());
                                    let resource = decision_context.and_then(|ctx| ctx.resource.as_deref());

                                    let _ = acp_capability::log_capability_reject(
                                        &state.db,
                                        &bot.bot_id,
                                        &bot.provider_account_id,
                                        frame_type,
                                        &err.to_string(),
                                        action,
                                        resource,
                                        decision_context,
                                    )
                                    .await
                                    .inspect_err(|log_err| {
                                        tracing::warn!(
                                            bot_id = %bot.bot_id,
                                            frame_type = frame_type,
                                            err = %log_err,
                                            "failed to persist capability reject log"
                                        );
                                    });

                                    if let Some(ctx) = err.decision_context() {
                                        tracing::warn!(
                                            bot_id = %bot.bot_id,
                                            frame_type = %ctx.frame_type,
                                            action = %ctx.action,
                                            scope_type = %ctx.delegation_scope_type,
                                            scope_id = ctx.delegation_scope_id.as_deref().unwrap_or("none"),
                                            request_session_id = ctx.request_session_id.as_deref().unwrap_or("none"),
                                            resolved_session_id = ctx.resolved_session_id.as_deref().unwrap_or("none"),
                                            resolved_session_status = ctx.resolved_session_status.as_deref().unwrap_or("none"),
                                            resolved_scope_type = ctx.resolved_session_scope_type.as_deref().unwrap_or("none"),
                                            resolved_scope_id = ctx.resolved_session_scope_id.as_deref().unwrap_or("none"),
                                            session_locator_source = ctx.session_locator_source.as_deref().unwrap_or("missing"),
                                            session_locator_value = ctx.session_locator_value.as_deref().unwrap_or("none"),
                                            resource = ctx.resource.as_deref().unwrap_or("none"),
                                            detail = %err,
                                            "data frame rejected by capability check"
                                        );
                                        } else {
                                        let frame_type = frame
                                            .get("type")
                                            .and_then(|value| value.as_str())
                                            .unwrap_or("unknown");
                                            tracing::warn!(
                                                bot_id = %bot.bot_id,
                                                frame_type = frame_type,
                                                err = %err,
                                                "data frame rejected by capability check"
                                            );
                                    }
                                    let _ = ws_send(
                                        &mut socket,
                                        &json!({
                                            "type": "error",
                                            "code": "CAPABILITY_DENIED",
                                            "detail": err.to_string(),
                                        }),
                                    )
                                    .await;
                                    continue;
                                }
                            }
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

async fn handle_data_frame(frame: &Value, state: &AppState, bot: &BotInfo, socket: &mut WebSocket) {
    let ftype = frame.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match ftype {
        // ── 流式输出（写后投递）────────────────────────────────────────────
        "delta" => {
            if let Err(e) = handle_delta(
                &state.stream_registry,
                &state.fanout,
                &state.db,
                bot.bot_id,
                &bot.provider_account_id,
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
                &state.bot_locator,
                bot.bot_id,
                &bot.provider_account_id,
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
        "session_update" => {
            if let Err(e) =
                handle_session_update(&state.db, bot.bot_id, &bot.provider_account_id, frame).await
            {
                tracing::warn!(bot_id = %bot.bot_id, err = e, "session_update rejected");
                let _ = ws_send(socket, &json!({ "type": "error", "detail": e })).await;
            }
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

async fn auth_bot_from_first_frame(socket: &mut WebSocket, state: &AppState) -> Option<BotInfo> {
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
        "SELECT bot_id, username, display_name, status, binding_config
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

    let bot_id: Uuid = row.try_get::<String, _>("bot_id").ok()?.parse().ok()?;
    let binding_config = row
        .try_get::<Option<Value>, _>("binding_config")
        .ok()
        .flatten();
    let provider_account_id = resolve_bot_provider_account_id(binding_config.as_ref())
        .unwrap_or_else(|| bot_id.to_string());
    Some(BotInfo {
        bot_id,
        provider_account_id,
        username: row.try_get("username").unwrap_or_default(),
        display_name: row.try_get("display_name").ok(),
        require_capability: resolve_bot_require_capability(binding_config.as_ref()),
        acp_security: resolve_bot_acp_security(binding_config),
    })
}

fn resolve_bot_require_capability(binding_config: Option<&Value>) -> bool {
    binding_config
        .and_then(|cfg| cfg.get("acp_security"))
        .and_then(|acp| acp.get("require_capability"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn resolve_bot_provider_account_id(binding_config: Option<&Value>) -> Option<String> {
    let top = binding_config?;

    fn trim_or_none(value: &Value) -> Option<String> {
        let value = value.as_str()?.trim();
        if value.is_empty() {
            return None;
        }
        Some(value.to_string())
    }

    if let Some(acp) = top.get("acp").and_then(Value::as_object) {
        for key in [
            "provider_account_id",
            "provider_account",
            "account_id",
            "account",
            "agent_id",
            "id",
        ] {
            if let Some(v) = acp.get(key).and_then(trim_or_none) {
                return Some(v);
            }
        }
    }

    for key in [
        "provider_account_id",
        "provider_account",
        "account_id",
        "account",
        "agent_id",
        "id",
    ] {
        if let Some(v) = top.get(key).and_then(trim_or_none) {
            return Some(v);
        }
    }

    None
}

fn resolve_bot_acp_security(binding_config: Option<Value>) -> Option<Value> {
    let acp_security = binding_config
        .as_ref()?
        .as_object()?
        .get("acp_security")?
        .as_object()?;

    let mode = acp_security
        .get("mode")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("X25519-ECDH");
    let algorithm = acp_security
        .get("algorithm")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("AES-256-GCM");
    let allow_plaintext_fallback = acp_security
        .get("allow_plaintext_fallback")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let require_capability = acp_security
        .get("require_capability")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    Some(json!({
        "enabled": acp_security.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        "mode": mode,
        "algorithm": algorithm,
        "allow_plaintext_fallback": allow_plaintext_fallback,
        "require_capability": require_capability,
        "phase": "negotiated",
    }))
}

async fn load_memberships(db: &PgPool, bot_id: Uuid) -> Vec<Value> {
    let rows = sqlx::query(
        "SELECT cm.channel_id, c.name
         FROM channel_memberships cm
         JOIN channels c ON c.channel_id = cm.channel_id
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

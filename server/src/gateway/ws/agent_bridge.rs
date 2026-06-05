/// Agent Bridge WebSocket 处理器。
///
/// 两个端点：
///   /ws/agent-bridge/control  —— 生命周期、task 派发
///   /ws/agent-bridge/data     —— delta/done/resource_req 等数据帧
use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    http::{header, HeaderMap},
    response::Response,
};
use serde_json::{json, Value};
use sqlx::Row;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::{
    app_state::AppState,
    domain::{acp_capability, channel_seq, sessions},
    gateway::{
        realtime::frame::WireFrame,
        stream::{handle_delta, handle_done, handle_send, handle_session_update},
    },
    infra::crypto::hash_bot_token,
    infra::db::models::MESSAGE_SCHEMA_VERSION,
    resource,
};
use sqlx::PgPool;

// ── 关闭码（与 WIRE_PROTOCOL 对齐）──────────────────────────────────────────
const CLOSE_AUTH_FAIL: u16 = 4401;
const CLOSE_BOT_UNAVAILABLE: u16 = 4403;
const CLOSE_SUPERSEDED: u16 = 4402;
const BRIDGE_PROTOCOL_VERSION: u32 = 1;

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
    /// connector 控制配置快照（来自 binding_config.connector_control）。
    connector_config: Option<Value>,
    owner_id: Option<String>,
}

// ── Control WS ────────────────────────────────────────────────────────────────

/// GET /ws/agent-bridge/control
pub async fn control_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    let header_token = bearer_token(&headers);
    ws.on_upgrade(move |socket| handle_control(socket, state, header_token))
}

async fn handle_control(mut socket: WebSocket, state: AppState, header_token: Option<String>) {
    // ── 1. 鉴权：优先 Authorization: Bearer，缺省时等待首帧 auth ─────────────
    let bot = match auth_bot(&mut socket, &state, header_token).await {
        Some(b) => b,
        None => return,
    };

    // ── 2. 注册 control 连接（supersede 旧连接）────────────────────────────
    let connection_id = Uuid::new_v4();
    let (task_tx, mut task_rx) = mpsc::channel::<Value>(64);

    // bind_control 先插入新 session，再向旧连接发 supersede 信号
    let mut supersede_rx = state
        .bot_registry
        .bind_control(bot.bot_id, connection_id, task_tx);

    // ── 3. 发 hello 帧（membership snapshot）─────────────────────────────
    let memberships = load_memberships(&state.db, bot.bot_id).await;
    let mut hello = json!({
        "type": "hello",
        "v": BRIDGE_PROTOCOL_VERSION,
        "bridge_protocol_version": BRIDGE_PROTOCOL_VERSION,
        "stream": "control",
        "bot_id": bot.bot_id,
        "bot_username": bot.username,
        "bot_display_name": bot.display_name,
        "connection_id": connection_id,
        "session_id": connection_id,
        "memberships": memberships,
        "connector_config": bot.connector_config,
        "server_capabilities": server_capabilities(),
    });
    if let Some(acp_security) = &bot.acp_security {
        hello["acp_security"] = acp_security.clone();
    }
    if ws_send(&mut socket, &hello).await.is_err() {
        return;
    }

    tracing::info!(bot_id = %bot.bot_id, "control connected");

    // ── 4. 双向读写循环 ───────────────────────────────────────────────────
    let superseded = loop {
        tokio::select! {
            // 收 bot 发来的控制帧
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                            handle_control_frame(&frame, &state, &bot).await;
                        }
                    }
                    Some(Ok(Message::Ping(d))) => { let _ = socket.send(Message::Pong(d)).await; }
                    Some(Ok(Message::Close(_))) | None => break false,
                    _ => {}
                }
            }

            // 收 dispatcher 发来的 task 帧，转发给 bot
            task = task_rx.recv() => {
                match task {
                    Some(t) => {
                        if ws_send(&mut socket, &t).await.is_err() { break false; }
                    }
                    None => break false,
                }
            }

            // 被新连接 supersede
            _ = &mut supersede_rx => {
                close(&mut socket, CLOSE_SUPERSEDED, "superseded by new connection").await;
                break true;
            }
        }
    };

    tracing::info!(bot_id = %bot.bot_id, superseded, "control disconnected");

    // 被 supersede 时新连接已写入 session，不能 unbind（会删掉新 session）
    if !superseded {
        state
            .bot_registry
            .unbind_if_connection(bot.bot_id, connection_id);
    }
}

async fn handle_control_frame(frame: &Value, state: &AppState, bot: &BotInfo) {
    let bot_id = bot.bot_id;
    let ftype = frame.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match ftype {
        "ping" => {} // pong 由 WS 层处理
        "ready" => {
            tracing::info!(bot_id = %bot_id, version = ?frame.get("plugin_version"), "bot ready");
        }
        "runtime_session_control_ack" => {
            match handle_runtime_session_control_ack(frame, state, bot).await {
                Ok(session_id) => {
                    tracing::info!(
                        bot_id = %bot_id,
                        session_id = %session_id,
                        "runtime session control ack applied"
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        bot_id = %bot_id,
                        err = %e,
                        "runtime session control ack rejected"
                    );
                }
            }
        }
        ftype @ ("config_status" | "config_options" | "config_option_status") => {
            // connector 上报配置状态，统一写入 binding_config.connector_control.*
            let config_key = match ftype {
                "config_status" => "last_status",
                "config_options" => "options",
                "config_option_status" => "last_option_status",
                _ => return,
            };
            let mut payload = frame.clone();
            // 去掉 type 字段，只存业务数据
            if let Some(obj) = payload.as_object_mut() {
                obj.remove("type");
            }
            let payload_str = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into());
            let result = sqlx::query(
                "UPDATE bot_accounts
                 SET binding_config = COALESCE(binding_config, '{}'::jsonb)
                     || jsonb_build_object(
                         'connector_control',
                         COALESCE(binding_config->'connector_control', '{}'::jsonb)
                         || jsonb_build_object($2::text, $3::jsonb)
                 )
                 WHERE bot_id = $1",
            )
            .bind(bot_id.to_string())
            .bind(config_key)
            .bind(&payload_str)
            .execute(&state.db)
            .await;
            if let Err(e) = result {
                tracing::warn!(bot_id = %bot_id, key = config_key, err = %e, "config persist failed");
            }
        }
        other => {
            tracing::debug!(bot_id = %bot_id, frame_type = other, "unknown control frame");
        }
    }
}

async fn handle_runtime_session_control_ack(
    frame: &Value,
    state: &AppState,
    bot: &BotInfo,
) -> Result<Uuid, crate::errors::AppError> {
    let ok = frame.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if !ok {
        return Err(crate::errors::AppError::BadRequest(
            frame
                .get("error")
                .or_else(|| frame.get("detail"))
                .and_then(Value::as_str)
                .unwrap_or("runtime_session_control failed")
                .to_string(),
        ));
    }

    let session = frame.get("session").unwrap_or(frame);
    let session_id = session
        .get("session_id")
        .or_else(|| session.get("id"))
        .and_then(Value::as_str)
        .and_then(|raw| raw.parse::<Uuid>().ok());
    let provider_session_key = session
        .get("provider_session_key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let provider_session_id = session
        .get("provider_session_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let status = session
        .get("status")
        .or_else(|| frame.get("status"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(sessions::SESSION_STATUS_ACTIVE);
    let metadata = Some(json!({
        "runtime_session_control_ack": {
            "request_id": frame.get("request_id").cloned().unwrap_or(Value::Null),
            "action": frame.get("action").cloned().unwrap_or(Value::Null),
            "status": status,
            "acked_at": chrono::Utc::now().to_rfc3339(),
        }
    }));

    sessions::apply_runtime_session_ack(
        &state.db,
        bot.bot_id,
        &bot.provider_account_id,
        session_id,
        provider_session_key,
        provider_session_id,
        status,
        metadata,
    )
    .await
}

// ── Data WS ───────────────────────────────────────────────────────────────────

/// GET /ws/agent-bridge/data
pub async fn data_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    let header_token = bearer_token(&headers);
    ws.on_upgrade(move |socket| handle_data(socket, state, header_token))
}

async fn handle_data(mut socket: WebSocket, state: AppState, header_token: Option<String>) {
    // ── 1. 鉴权 ──────────────────────────────────────────────────────────
    let bot = match auth_bot(&mut socket, &state, header_token).await {
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
        "v": BRIDGE_PROTOCOL_VERSION,
        "bridge_protocol_version": BRIDGE_PROTOCOL_VERSION,
        "stream": "data",
        "bot_id": bot.bot_id,
        "connection_id": connection_id,
        "session_id": connection_id,
        "last_event_seq": 0,
        "server_capabilities": server_capabilities(),
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
                                            .and_then(Value::as_str)
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
                                        &bridge_error("CAPABILITY_DENIED", &err.to_string()),
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
    state.bot_registry.unbind_data(bot.bot_id);
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
                let _ = ws_send(socket, &bridge_error("DELTA_REJECTED", e)).await;
            }
        }

        "done" => {
            handle_terminal_frame(frame, state, bot, socket, TerminalAckKind::Terminal).await;
        }

        "error" => {
            if frame.get("msg_id").is_some() {
                let mut normalized = frame.clone();
                normalized["type"] = json!("done");
                if normalized.get("content").and_then(Value::as_str).is_none() {
                    normalized["content"] = json!(frame
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("connector reported an error"));
                }
                handle_terminal_frame(&normalized, state, bot, socket, TerminalAckKind::Terminal)
                    .await;
            } else {
                tracing::debug!(bot_id = %bot.bot_id, "connector protocol error frame received");
            }
        }

        "reply" => {
            let mut normalized = frame.clone();
            normalized["type"] = json!("done");
            if normalized.get("msg_id").and_then(Value::as_str).is_none() {
                if let Some(reply_to) = frame.get("reply_to_msg_id").and_then(Value::as_str) {
                    normalized["msg_id"] = json!(reply_to);
                }
            }
            if normalized.get("content").and_then(Value::as_str).is_none() {
                normalized["content"] =
                    json!(frame.get("text").and_then(Value::as_str).unwrap_or(""));
            }
            handle_terminal_frame(&normalized, state, bot, socket, TerminalAckKind::Send).await;
        }

        // ── bot 主动发新消息 ───────────────────────────────────────────────
        "send" => {
            let client_msg_id = client_msg_id(frame);
            match handle_send(&state.fanout, &state.db, bot.bot_id, frame).await {
                Ok(msg_id) => {
                    if let Some(client_msg_id) = client_msg_id {
                        let _ = ws_send(socket, &send_ack_ok(&client_msg_id, msg_id, false)).await;
                    }
                }
                Err(e) => {
                    tracing::warn!(bot_id = %bot.bot_id, err = e, "send failed");
                    if let Some(client_msg_id) = client_msg_id {
                        let _ =
                            ws_send(socket, &send_ack_err(&client_msg_id, "SEND_FAILED", e)).await;
                    } else {
                        let _ = ws_send(socket, &bridge_error("SEND_FAILED", e)).await;
                    }
                }
            }
        }

        // ── resource 访问 ──────────────────────────────────────────────────
        "resource_req" => {
            let resp =
                resource::dispatch(&state.db, resource::Principal::bot(bot.bot_id), frame).await;
            // resource_res 发回给 bot（通过同一条 data WS）
            let _ = ws_send(socket, &resp).await;
        }

        // ── 审批请求（转发给频道内用户）─────────────────────────────────────
        "permission_request" => {
            let client_msg_id = client_msg_id(frame);
            match handle_permission_request_frame(frame, state, bot).await {
                Ok(message_id) => {
                    if let Some(client_msg_id) = client_msg_id {
                        let _ =
                            ws_send(socket, &send_ack_ok(&client_msg_id, message_id, false)).await;
                    }
                }
                Err(e) => {
                    tracing::warn!(bot_id = %bot.bot_id, err = e, "permission_request rejected");
                    if let Some(client_msg_id) = client_msg_id {
                        let _ = ws_send(
                            socket,
                            &send_ack_err(&client_msg_id, "PERMISSION_REQUEST_FAILED", e),
                        )
                        .await;
                    } else {
                        let _ =
                            ws_send(socket, &bridge_error("PERMISSION_REQUEST_FAILED", e)).await;
                    }
                }
            }
        }
        "session_update" => {
            if let Err(e) =
                handle_session_update(&state.db, bot.bot_id, &bot.provider_account_id, frame).await
            {
                tracing::warn!(bot_id = %bot.bot_id, err = e, "session_update rejected");
                let _ = ws_send(socket, &bridge_error("SESSION_UPDATE_FAILED", e)).await;
            }
        }

        "ping" => {
            let _ = ws_send(socket, &json!({ "type": "pong" })).await;
        }

        "resume" => {
            // event_log 重放：需要 event_log 表基础设施，暂未实现。
            // 当前 last_event_seq 始终返回 0，bot 重连后需自行通过
            // channel.activity.read?since_seq=<last_known> 补齐上下文。
            tracing::debug!(bot_id = %bot.bot_id, "resume frame received (not yet implemented)");
            let up_to_seq = frame
                .get("last_event_seq")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .max(0);
            let _ = ws_send(
                socket,
                &json!({
                    "type": "resume_ack",
                    "v": BRIDGE_PROTOCOL_VERSION,
                    "replayed": 0,
                    "up_to_seq": up_to_seq,
                }),
            )
            .await;
        }

        other => {
            tracing::debug!(bot_id = %bot.bot_id, frame_type = other, "unknown data frame");
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum TerminalAckKind {
    Terminal,
    Send,
}

async fn handle_terminal_frame(
    frame: &Value,
    state: &AppState,
    bot: &BotInfo,
    socket: &mut WebSocket,
    ack_kind: TerminalAckKind,
) {
    let client_msg_id = client_msg_id(frame);
    let msg_id = frame
        .get("msg_id")
        .and_then(Value::as_str)
        .and_then(|raw| raw.parse::<Uuid>().ok());

    match handle_done(
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
        Ok(()) => {
            let Some(client_msg_id) = client_msg_id else {
                return;
            };
            let Some(msg_id) = msg_id else {
                let _ = ws_send(
                    socket,
                    &terminal_ack_err(&client_msg_id, "INVALID_FRAME", "missing msg_id"),
                )
                .await;
                return;
            };
            let ack = match ack_kind {
                TerminalAckKind::Terminal => terminal_ack_ok(&client_msg_id, msg_id),
                TerminalAckKind::Send => send_ack_ok(&client_msg_id, msg_id, true),
            };
            let _ = ws_send(socket, &ack).await;
        }
        Err(e) => {
            tracing::warn!(bot_id = %bot.bot_id, err = e, "terminal frame rejected");
            if let Some(client_msg_id) = client_msg_id {
                let ack = match ack_kind {
                    TerminalAckKind::Terminal => {
                        terminal_ack_err(&client_msg_id, "TERMINAL_REJECTED", e)
                    }
                    TerminalAckKind::Send => send_ack_err(&client_msg_id, "REPLY_REJECTED", e),
                };
                let _ = ws_send(socket, &ack).await;
            } else {
                let _ = ws_send(socket, &bridge_error("TERMINAL_REJECTED", e)).await;
            }
        }
    }
}

async fn handle_permission_request_frame(
    frame: &Value,
    state: &AppState,
    bot: &BotInfo,
) -> Result<Uuid, &'static str> {
    let channel_id: Uuid = frame
        .get("channel_id")
        .and_then(Value::as_str)
        .and_then(|raw| raw.parse().ok())
        .ok_or("missing channel_id")?;
    ensure_bot_channel_member(&state.db, bot.bot_id, channel_id).await?;

    let msg_id = Uuid::new_v4();
    let title = frame
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Approval needed");
    let body = frame
        .get("body")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("The agent requested approval.");
    let content = if title == "Approval needed" {
        body.to_string()
    } else {
        format!("{title}\n\n{body}")
    };
    let content_data = json!({
        "kind": "agent_bridge_permission_request",
        "request_id": frame.get("request_id").cloned().unwrap_or(Value::Null),
        "task_id": frame.get("task_id").cloned().unwrap_or(Value::Null),
        "source_msg_id": frame.get("msg_id").cloned().unwrap_or(Value::Null),
        "session_id": frame.get("session_id").cloned().unwrap_or(Value::Null),
        "provider_session_key": frame.get("provider_session_key").cloned().unwrap_or(Value::Null),
        "provider_session_id": frame.get("provider_session_id").cloned().unwrap_or(Value::Null),
        "title": title,
        "body": body,
        "tool": frame.get("tool").cloned().unwrap_or(Value::Null),
        "options": frame.get("options").cloned().unwrap_or_else(|| json!([])),
        "resolved": false,
        "bot_owner_id": bot.owner_id.clone(),
    });
    let content_data_for_db = content_data.to_string();

    let mut tx = state.db.begin().await.map_err(|_| "db error")?;
    let channel_seq = channel_seq::allocate(&mut tx, channel_id)
        .await
        .map_err(|_| "db error")?;
    sqlx::query(
        "INSERT INTO messages
            (msg_id, channel_id, sender_type, sender_id, content, msg_type,
             is_partial, content_data, file_ids, channel_seq)
         VALUES ($1, $2, 'bot', $3, $4, 'permission', FALSE, $5::jsonb, '[]'::jsonb, $6)",
    )
    .bind(msg_id.to_string())
    .bind(channel_id.to_string())
    .bind(bot.bot_id.to_string())
    .bind(&content)
    .bind(&content_data_for_db)
    .bind(channel_seq)
    .execute(&mut *tx)
    .await
    .map_err(|_| "db error")?;
    tx.commit().await.map_err(|_| "db error")?;

    let wire = WireFrame::channel(
        channel_id,
        "message",
        json!({
            "v": MESSAGE_SCHEMA_VERSION,
            "msg_id": msg_id,
            "channel_id": channel_id,
            "channel_seq": channel_seq,
            "sender_type": "bot",
            "sender_id": bot.bot_id,
            "content": content,
            "msg_type": "permission",
            "is_partial": false,
            "reply_to_msg_id": null,
            "file_ids": [],
            "mentions": [],
            "files": [],
            "content_data": content_data,
        }),
    );
    state.fanout.broadcast_channel(channel_id, wire).await;

    Ok(msg_id)
}

async fn ensure_bot_channel_member(
    db: &PgPool,
    bot_id: Uuid,
    channel_id: Uuid,
) -> Result<(), &'static str> {
    let is_member = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM channel_memberships
            WHERE channel_id = $1 AND member_id = $2 AND member_type = 'bot'
        ) AS ok",
    )
    .bind(channel_id.to_string())
    .bind(bot_id.to_string())
    .fetch_one(db)
    .await
    .map_err(|_| "db error")?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);

    if is_member {
        Ok(())
    } else {
        Err("bot is not a member of the target channel")
    }
}

fn client_msg_id(frame: &Value) -> Option<String> {
    frame
        .get("client_msg_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn send_ack_ok(client_msg_id: &str, message_id: Uuid, finalized_placeholder: bool) -> Value {
    json!({
        "type": "send_ack",
        "v": BRIDGE_PROTOCOL_VERSION,
        "client_msg_id": client_msg_id,
        "ok": true,
        "message_id": message_id,
        "finalized_placeholder": finalized_placeholder,
    })
}

fn send_ack_err(client_msg_id: &str, code: &str, error: &str) -> Value {
    json!({
        "type": "send_ack",
        "v": BRIDGE_PROTOCOL_VERSION,
        "client_msg_id": client_msg_id,
        "ok": false,
        "code": code,
        "error": error,
    })
}

fn terminal_ack_ok(client_msg_id: &str, msg_id: Uuid) -> Value {
    json!({
        "type": "terminal_ack",
        "v": BRIDGE_PROTOCOL_VERSION,
        "client_msg_id": client_msg_id,
        "ok": true,
        "msg_id": msg_id,
    })
}

fn terminal_ack_err(client_msg_id: &str, code: &str, error: &str) -> Value {
    json!({
        "type": "terminal_ack",
        "v": BRIDGE_PROTOCOL_VERSION,
        "client_msg_id": client_msg_id,
        "ok": false,
        "code": code,
        "error": error,
    })
}

fn bridge_error(code: &str, detail: &str) -> Value {
    json!({
        "type": "error",
        "v": BRIDGE_PROTOCOL_VERSION,
        "code": code,
        "detail": detail,
    })
}

fn server_capabilities() -> Value {
    json!({
        "auth": ["authorization_bearer", "auth_frame"],
        "task_stream": "control",
        "runtime_session_control": true,
        "resource_req": true,
        "send_ack": true,
        "terminal_ack": true,
        "resume": "ack_only",
        "file_upload": false,
        "acp_security": true,
    })
}

// ── 鉴权：Authorization Bearer 或首帧 auth ─────────────────────────────────────

#[derive(Debug)]
enum AuthFailure {
    InvalidToken,
    BotUnavailable,
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|raw| raw.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

async fn auth_bot(
    socket: &mut WebSocket,
    state: &AppState,
    header_token: Option<String>,
) -> Option<BotInfo> {
    if let Some(token) = header_token {
        return match resolve_bot(&state.db, &token).await {
            Ok(bot) => Some(bot),
            Err(AuthFailure::BotUnavailable) => {
                close(socket, CLOSE_BOT_UNAVAILABLE, "bot is not online").await;
                None
            }
            Err(AuthFailure::InvalidToken) => {
                close(socket, CLOSE_AUTH_FAIL, "invalid or revoked token").await;
                None
            }
        };
    }

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

                if frame.get("type").and_then(Value::as_str) != Some("auth") {
                    close(socket, CLOSE_AUTH_FAIL, "first JSON frame must be auth").await;
                    return None;
                }

                let token = match frame.get("token").and_then(Value::as_str) {
                    Some(t) => t.to_string(),
                    None => {
                        close(socket, CLOSE_AUTH_FAIL, "missing auth token").await;
                        return None;
                    }
                };

                match resolve_bot(&state.db, &token).await {
                    Ok(bot) => return Some(bot),
                    Err(AuthFailure::BotUnavailable) => {
                        close(socket, CLOSE_BOT_UNAVAILABLE, "bot is not online").await;
                        return None;
                    }
                    Err(AuthFailure::InvalidToken) => {
                        close(socket, CLOSE_AUTH_FAIL, "invalid or revoked token").await;
                        return None;
                    }
                }
            }
        }
    }
}

/// 通过 botToken 查找并验证 bot。
async fn resolve_bot(db: &PgPool, token: &str) -> Result<BotInfo, AuthFailure> {
    let token_hash = hash_bot_token(token);

    let row = sqlx::query(
        "SELECT bot_id, username, display_name, status, binding_config, created_by
         FROM bot_accounts WHERE bot_token_hash = $1",
    )
    .bind(&token_hash)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .ok_or(AuthFailure::InvalidToken)?;

    let status: String = row.try_get("status").unwrap_or_default();
    if status != "online" {
        return Err(AuthFailure::BotUnavailable);
    }

    let bot_id: Uuid = row
        .try_get::<String, _>("bot_id")
        .ok()
        .and_then(|raw| raw.parse().ok())
        .ok_or(AuthFailure::InvalidToken)?;
    let binding_config = row
        .try_get::<Option<Value>, _>("binding_config")
        .ok()
        .flatten();
    let provider_account_id = resolve_bot_provider_account_id(binding_config.as_ref())
        .unwrap_or_else(|| bot_id.to_string());
    Ok(BotInfo {
        bot_id,
        provider_account_id,
        username: row.try_get("username").unwrap_or_default(),
        display_name: row.try_get("display_name").ok(),
        require_capability: resolve_bot_require_capability(binding_config.as_ref()),
        acp_security: resolve_bot_acp_security(binding_config.as_ref()),
        connector_config: resolve_bot_connector_config(binding_config.as_ref()),
        owner_id: row
            .try_get::<Option<String>, _>("created_by")
            .ok()
            .flatten(),
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

fn resolve_bot_connector_config(binding_config: Option<&Value>) -> Option<Value> {
    binding_config
        .and_then(|cfg| cfg.get("connector_control"))
        .filter(|value| value.is_object())
        .cloned()
}

fn resolve_bot_acp_security(binding_config: Option<&Value>) -> Option<Value> {
    let acp_security = binding_config?
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

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
        stream::{
            broadcast_and_trigger_created_message, handle_delta, handle_done, handle_send,
            handle_session_update,
        },
    },
    infra::crypto::hash_bot_token,
    infra::db::models::MESSAGE_SCHEMA_VERSION,
    resource,
};
use sqlx::PgPool;

// ── 关闭码（与 WIRE_PROTOCOL 对齐；共享常量在 cheers-bridge-protocol）─────────
use cheers_bridge_protocol as proto;
use cheers_bridge_protocol::{
    WS_CLOSE_AUTH_FAIL as CLOSE_AUTH_FAIL, WS_CLOSE_BOT_UNAVAILABLE as CLOSE_BOT_UNAVAILABLE,
    WS_CLOSE_SUPERSEDED as CLOSE_SUPERSEDED, WS_CLOSE_UNSUPPORTED_PROTOCOL as CLOSE_PROTOCOL_ERROR,
};
/// Heartbeat idle close (WIRE_PROTOCOL §10.1): a connector whose process died
/// without a clean TCP FIN would otherwise stay "online" until the OS notices.
/// Gateway-local (connectors treat it as retryable), so not in the shared crate.
const CLOSE_IDLE_TIMEOUT: u16 = 4409;
/// A connector that keeps sending unparseable frames is buggy/hostile — close it
/// with a protocol-error code after this many CONSECUTIVE malformed frames so it
/// can't spin the read loop / hammer logs. A good frame resets the counter.
const MAX_MALFORMED_FRAMES: u32 = 20;
use crate::gateway::bridge_frames::{
    self, bridge_error, send_ack_err, send_ack_ok, terminal_ack_err, terminal_ack_ok,
    BRIDGE_PROTOCOL_VERSION,
};

/// Gateway-side liveness: probe with a WS ping every PROBE_INTERVAL (the peer's
/// WS stack auto-pongs, so this needs no connector cooperation), reap after
/// IDLE_TIMEOUT with no inbound traffic (= 3 missed probes; the connector's own
/// 25s app-level heartbeat also resets the timer).
const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);
const PROBE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

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
    let hello = bridge_frames::control_hello_frame(
        bot.bot_id,
        &bot.username,
        bot.display_name.as_deref(),
        connection_id,
        Value::Array(memberships),
        bot.connector_config.as_ref(),
        server_capabilities(&state),
        bot.acp_security.as_ref(),
    );
    if ws_send(&mut socket, &hello).await.is_err() {
        return;
    }

    // Connect-sync the persisted L1 posture mode (Axis A): a reconnecting connector
    // boots from its TOML default, so re-push any owner override made while it was
    // offline. The connector re-clamps via L0 (both gates) — we only transport it.
    if let Some(mode) = bot
        .connector_config
        .as_ref()
        .and_then(|c| c.get("agentNativePermissionMode"))
        .and_then(Value::as_str)
    {
        let cfg =
            bridge_frames::config_update_frame(cheers_bridge_protocol::ConnectorControlSettings {
                agent_native_permission_mode: Some(mode.to_string()),
                ..Default::default()
            });
        let _ = ws_send(&mut socket, &cfg).await;
    }

    // Connect-sync the owner's desired ACP config options too (same rationale as
    // posture): a reconnecting connector boots from its TOML default, so re-push
    // any overrides. The connector re-clamps via L0 allowed_config_options.
    if let Some(opts) = bot
        .connector_config
        .as_ref()
        .and_then(|c| c.get("configOptions"))
        .filter(|v| v.as_object().is_some_and(|m| !m.is_empty()))
    {
        let cfg =
            bridge_frames::config_update_frame(cheers_bridge_protocol::ConnectorControlSettings {
                config_options: Some(opts.clone()),
                ..Default::default()
            });
        let _ = ws_send(&mut socket, &cfg).await;
    }

    tracing::info!(bot_id = %bot.bot_id, "control connected");
    crate::domain::bot_events::record_bg(
        &state.db,
        bot.bot_id,
        "control",
        crate::domain::bot_events::EVENT_CONNECTED,
        None,
        connection_id,
    );

    // bot 在线状态可能刚翻转（is_online = control + data 均在线）→ 向其频道广播 presence。
    crate::gateway::presence::broadcast_bot_presence(&state, bot.bot_id).await;

    // ── 4. 双向读写循环 ───────────────────────────────────────────────────
    let mut malformed: u32 = 0;
    let idle = tokio::time::sleep(IDLE_TIMEOUT);
    tokio::pin!(idle);
    let mut probe = tokio::time::interval(PROBE_INTERVAL);
    probe.tick().await; // first tick fires immediately — skip it.
    let reason = loop {
        tokio::select! {
            // 收 bot 发来的控制帧（任何入站流量都重置 idle 计时器）
            msg = socket.recv() => {
                idle.as_mut().reset(tokio::time::Instant::now() + IDLE_TIMEOUT);
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<Value>(&text) {
                            Ok(frame) => {
                                malformed = 0;
                                handle_control_frame(&frame, &state, &bot).await;
                            }
                            Err(e) => {
                                malformed += 1;
                                tracing::warn!(bot_id = %bot.bot_id, malformed, error = %e, "malformed control frame (ignored)");
                                if malformed >= MAX_MALFORMED_FRAMES {
                                    close(&mut socket, CLOSE_PROTOCOL_ERROR, "too many malformed frames").await;
                                    break "protocol_error";
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Ping(d))) => { let _ = socket.send(Message::Pong(d)).await; }
                    Some(Ok(Message::Close(_))) | None => break "closed",
                    _ => {}
                }
            }

            // 收 dispatcher 发来的 task 帧，转发给 bot
            task = task_rx.recv() => {
                match task {
                    Some(t) => {
                        if ws_send(&mut socket, &t).await.is_err() { break "write_failed"; }
                    }
                    None => break "unbound",
                }
            }

            // 被新连接 supersede（仅当有人显式发送信号，非 channel 关闭）
            result = &mut supersede_rx => {
                if result.is_ok() {
                    close(&mut socket, CLOSE_SUPERSEDED, "superseded by new connection").await;
                    break "superseded";
                }
                break "closed";
            }

            // 心跳兜底：连 IDLE_TIMEOUT 没有任何入站帧（含 WS pong）→ 回收连接。
            _ = &mut idle => {
                close(&mut socket, CLOSE_IDLE_TIMEOUT, "heartbeat idle timeout").await;
                break "idle_timeout";
            }
            _ = probe.tick() => {
                if socket.send(Message::Ping(Vec::new())).await.is_err() { break "closed"; }
            }
        }
    };

    let superseded = reason == "superseded";
    tracing::info!(bot_id = %bot.bot_id, reason, "control disconnected");
    crate::domain::bot_events::record_bg(
        &state.db,
        bot.bot_id,
        "control",
        crate::domain::bot_events::EVENT_DISCONNECTED,
        Some(reason),
        connection_id,
    );

    // 被 supersede 时新连接已写入 session，不能 unbind（会删掉新 session）
    if !superseded {
        state
            .bot_registry
            .unbind_if_connection(bot.bot_id, connection_id);
        crate::gateway::presence::broadcast_bot_presence(&state, bot.bot_id).await;
    }
}

async fn handle_control_frame(frame: &Value, state: &AppState, bot: &BotInfo) {
    let bot_id = bot.bot_id;
    // Typed parse — the shared enum is the single schema both ends compile
    // against, so a field rename can no longer silently read as None (the
    // plugin_version bug class). Handlers that persist or tolerate legacy
    // shapes still receive the raw `frame` for their payload.
    let parsed: proto::ControlOutbound = match serde_json::from_value(frame.clone()) {
        Ok(parsed) => parsed,
        Err(err) => {
            tracing::warn!(
                bot_id = %bot_id,
                frame_type = frame.get("type").and_then(|v| v.as_str()).unwrap_or(""),
                %err,
                "control frame failed typed parse"
            );
            return;
        }
    };
    match parsed {
        proto::ControlOutbound::Ping => {} // pong 由 WS 层处理
        proto::ControlOutbound::Ready {
            connector_version,
            plugin_version,
            connector_capabilities,
            ..
        } => {
            // The Rust connector reports `connector_version`; the retired TS
            // connector used `plugin_version` — both are first-class fields on
            // the shared Ready variant (pinned by fixtures/compat/).
            let connector_version = connector_version.or(plugin_version);
            tracing::info!(bot_id = %bot_id, version = ?connector_version, "bot ready");
            // Persist the connector's advertised capabilities (e.g. whether the
            // downstream agent accepts audio/image prompts) so the platform can
            // consult them offline — the composer warns before sending voice to
            // a bot that can't hear it, and the dispatcher skips inlining bytes
            // the agent would only discard. Refreshed on every (re)connect, so
            // a connector upgrade updates them automatically. The version rides
            // along so bot status can report update availability while offline.
            let caps = connector_capabilities;
            if caps.is_some() || connector_version.is_some() {
                let caps_str = serde_json::to_string(&caps.unwrap_or(Value::Null))
                    .unwrap_or_else(|_| "null".into());
                let result = sqlx::query(
                    "UPDATE bot_accounts
                     SET binding_config = COALESCE(binding_config, '{}'::jsonb)
                         || jsonb_build_object(
                             'connector_control',
                             COALESCE(binding_config->'connector_control', '{}'::jsonb)
                             || CASE WHEN $2::jsonb IS NOT NULL AND $2::jsonb <> 'null'::jsonb
                                     THEN jsonb_build_object(
                                         'capabilities', $2::jsonb,
                                         'capabilities_updated_at', to_jsonb(NOW())
                                     )
                                     ELSE '{}'::jsonb END
                             || CASE WHEN $3::text IS NOT NULL
                                     THEN jsonb_build_object('connector_version', $3::text)
                                     ELSE '{}'::jsonb END
                     )
                     WHERE bot_id = $1",
                )
                .bind(bot_id.to_string())
                .bind(&caps_str)
                .bind(connector_version.as_deref())
                .execute(&state.db)
                .await;
                if let Err(e) = result {
                    tracing::warn!(bot_id = %bot_id, err = %e, "capabilities persist failed");
                }
            }
        }
        proto::ControlOutbound::RuntimeSessionControlAck { .. } => {
            // The handler keeps the raw frame: it tolerates the legacy shape
            // where session fields live at the top level instead of `session{}`.
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
        proto::ControlOutbound::ConfigOptions { options, v } => {
            // Advertised-options snapshot (configOptions / modes / models /
            // availableCommands / currentModeId / currentModelId). PATCH-merge:
            // each report carries only the fields its source event had (e.g. an
            // available_commands_update has no configOptions), so incoming
            // fields overlay the stored snapshot instead of replacing it —
            // otherwise a later commands update would null out the model list.
            let mut incoming = options.as_object().cloned().unwrap_or_default();
            // Defense against older connectors that still send explicit nulls.
            incoming.retain(|_, v| !v.is_null());
            let incoming_str =
                serde_json::to_string(&Value::Object(incoming)).unwrap_or_else(|_| "{}".into());
            let v_str = v.to_string();
            let result = sqlx::query(
                "UPDATE bot_accounts SET binding_config = jsonb_set(
                     jsonb_set(
                         COALESCE(binding_config, '{}'::jsonb),
                         '{connector_control}',
                         COALESCE(binding_config -> 'connector_control', '{}'::jsonb),
                         true),
                     '{connector_control,options}',
                     jsonb_build_object(
                         'v', $2::jsonb,
                         'options',
                         COALESCE(binding_config #> '{connector_control,options,options}',
                                  '{}'::jsonb) || $3::jsonb),
                     true)
                 WHERE bot_id = $1",
            )
            .bind(bot_id.to_string())
            .bind(&v_str)
            .bind(&incoming_str)
            .execute(&state.db)
            .await;
            if let Err(e) = result {
                tracing::warn!(bot_id = %bot_id, err = %e, "config options merge failed");
            }
        }
        kind @ (proto::ControlOutbound::ConfigStatus { .. }
        | proto::ControlOutbound::ConfigOptionStatus { .. }) => {
            // connector 上报配置状态，统一写入 binding_config.connector_control.*
            // Raw `frame` is persisted (minus type) so fields beyond the typed
            // schema survive in the stored blob.
            let config_key = match kind {
                proto::ControlOutbound::ConfigStatus { .. } => "last_status",
                _ => "last_option_status",
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
        proto::ControlOutbound::Auth { .. } | proto::ControlOutbound::Unknown => {
            tracing::debug!(
                bot_id = %bot_id,
                frame_type = frame.get("type").and_then(|v| v.as_str()).unwrap_or(""),
                "unhandled control frame"
            );
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

    state
        .bot_registry
        .bind_data(bot.bot_id, connection_id, res_tx);

    // ── 3. 发 hello 帧 ──────────────────────────────────────────────────
    // last_event_seq: 最后一次事件的 seq（重连重放用，暂返回 0）
    let hello = bridge_frames::data_hello_frame(
        bot.bot_id,
        connection_id,
        server_capabilities(&state),
        bot.acp_security.as_ref(),
    );
    if ws_send(&mut socket, &hello).await.is_err() {
        return;
    }

    tracing::info!(bot_id = %bot.bot_id, "data connected");
    crate::domain::bot_events::record_bg(
        &state.db,
        bot.bot_id,
        "data",
        crate::domain::bot_events::EVENT_CONNECTED,
        None,
        connection_id,
    );

    // data WS 接上后 is_online 可能翻转为在线 → 向其频道广播 presence。
    crate::gateway::presence::broadcast_bot_presence(&state, bot.bot_id).await;

    // ── 4. 双向读写循环 ───────────────────────────────────────────────────
    let mut malformed: u32 = 0;
    let idle = tokio::time::sleep(IDLE_TIMEOUT);
    tokio::pin!(idle);
    let mut probe = tokio::time::interval(PROBE_INTERVAL);
    probe.tick().await; // first tick fires immediately — skip it.
    let reason = loop {
        tokio::select! {
            msg = socket.recv() => {
                idle.as_mut().reset(tokio::time::Instant::now() + IDLE_TIMEOUT);
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                            malformed = 0;
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
                        } else {
                            malformed += 1;
                            tracing::warn!(bot_id = %bot.bot_id, malformed, "malformed data frame (ignored)");
                            if malformed >= MAX_MALFORMED_FRAMES {
                                close(&mut socket, CLOSE_PROTOCOL_ERROR, "too many malformed frames").await;
                                break "protocol_error";
                            }
                        }
                    }
                    Some(Ok(Message::Ping(d))) => { let _ = socket.send(Message::Pong(d)).await; }
                    Some(Ok(Message::Close(_))) | None => break "closed",
                    _ => {}
                }
            }

            // Backend 发给 bot 的帧（resource_res、permission_request 等）
            outbound = res_rx.recv() => {
                match outbound {
                    Some(frame) => {
                        if ws_send(&mut socket, &frame).await.is_err() { break "write_failed"; }
                    }
                    None => break "unbound",
                }
            }

            // 心跳兜底：连 IDLE_TIMEOUT 没有任何入站帧（含 WS pong）→ 回收连接。
            _ = &mut idle => {
                close(&mut socket, CLOSE_IDLE_TIMEOUT, "heartbeat idle timeout").await;
                break "idle_timeout";
            }
            _ = probe.tick() => {
                if socket.send(Message::Ping(Vec::new())).await.is_err() { break "closed"; }
            }
        }
    };

    tracing::info!(bot_id = %bot.bot_id, reason, "data disconnected");
    crate::domain::bot_events::record_bg(
        &state.db,
        bot.bot_id,
        "data",
        crate::domain::bot_events::EVENT_DISCONNECTED,
        Some(reason),
        connection_id,
    );
    // conn 守护：重连后旧 data socket 的迟到 cleanup 不会打掉新绑定（也就不会
    // 把实际在线的 bot 广播成离线）。
    state.bot_registry.unbind_data(bot.bot_id, connection_id);
    crate::gateway::presence::broadcast_bot_presence(&state, bot.bot_id).await;
}

/// Data-stream dispatch stays STRING-routed on purpose (unlike the typed
/// control dispatch): several readers deliberately tolerate legacy shapes a
/// strict `proto::DataOutbound` parse would reject — `delta` accepts
/// `delta|content`, `done`/`reply`/`send` accept `content|text`, and `reply`
/// isn't a variant at all (retired TS connector frame). Those aliases are
/// wire-compat contracts, not drift; the typed schema both ends COMPILE
/// against plus the golden fixtures already pin the canonical shapes (see
/// bridge_frames::tests::to_gateway_fixtures_parse_typed).
async fn handle_data_frame(frame: &Value, state: &AppState, bot: &BotInfo, socket: &mut WebSocket) {
    let ftype = frame.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match ftype {
        // ── 流式输出（写后投递）────────────────────────────────────────────
        "delta" => {
            tracing::debug!(
                bot_id = %bot.bot_id,
                msg_id = frame.get("msg_id").and_then(|v| v.as_str()).unwrap_or(""),
                bytes = frame
                    .get("delta")
                    .or_else(|| frame.get("content"))
                    .and_then(|v| v.as_str())
                    .map(str::len)
                    .unwrap_or(0),
                "delta frame"
            );
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
            tracing::info!(
                bot_id = %bot.bot_id,
                msg_id = frame.get("msg_id").and_then(|v| v.as_str()).unwrap_or(""),
                "terminal (done) frame received"
            );
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
            match handle_send(
                &state.stream_registry,
                &state.fanout,
                &state.db,
                &state.bot_locator,
                bot.bot_id,
                frame,
            )
            .await
            {
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
            // `workspace.read` is a REMOTE-workspace pull (unified context model, P3):
            // a reader bot resolves ANOTHER bot's workspace file under its own read
            // grant. It can't go through the db-only `resource::dispatch` — brokering
            // the read needs `AppState` (the identity-free workspace RPC + presence).
            // Intercept here at the WS boundary; every other verb falls through.
            let resp = if frame.get("resource").and_then(Value::as_str) == Some("workspace.read") {
                broker_workspace_read(state, bot.bot_id, frame).await
            } else {
                resource::dispatch(&state.db, resource::Principal::bot(bot.bot_id), frame).await
            };
            // bot 主动 post_message（channel.messages.create）落库后，resource::dispatch 只有
            // db、无 fanout/registry/bot_locator，故在此 WS 边界补 live 广播 + bot@bot 触发。
            if frame.get("resource").and_then(Value::as_str) == Some("channel.messages.create")
                && resp.get("ok").and_then(Value::as_bool) == Some(true)
            {
                if let Some(created) = resp.get("data") {
                    // Off the critical path: the message is already committed, so the
                    // resource_res below can return immediately. The live broadcast
                    // (Redis PUBLISH) + chain resolution + bot@bot trigger all run in a
                    // spawned task instead of blocking the caller's post_message reply.
                    // Ordering is safe: the frontend re-sorts incoming "message" frames
                    // by channel_seq (ChannelView.upsertMessage), so a broadcast that
                    // lands after the reply can't misorder the channel.
                    let registry = state.stream_registry.clone();
                    let fanout = state.fanout.clone();
                    let db = state.db.clone();
                    let bot_locator = state.bot_locator.clone();
                    let author_bot_id = bot.bot_id;
                    let created = created.clone();
                    tokio::spawn(async move {
                        let started = std::time::Instant::now();
                        let _ = broadcast_and_trigger_created_message(
                            &registry,
                            &fanout,
                            &db,
                            &bot_locator,
                            author_bot_id,
                            &created,
                        )
                        .await;
                        tracing::debug!(
                            elapsed_ms = started.elapsed().as_millis() as u64,
                            "post_message broadcast+trigger complete (off critical path)"
                        );
                    });
                }
            }
            // bot 退出频道成功 → 成员集变了，在 WS 边界补发全量 presence
            //（resource::dispatch 只有 db，拿不到 fanout/bot_locator）。
            if frame.get("resource").and_then(Value::as_str) == Some("channel.leave")
                && resp.get("ok").and_then(Value::as_bool) == Some(true)
            {
                if let Some(cid) = frame
                    .get("params")
                    .and_then(|p| p.get("channel_id"))
                    .and_then(Value::as_str)
                    .and_then(|s| Uuid::parse_str(s).ok())
                {
                    crate::gateway::presence::broadcast_presence(state, cid).await;
                }
            }
            // Live Desk: a successful mutating `fs.*` verb changed the channel's
            // workspace files — nudge any open Desk view to re-pull. Mirrors the
            // channel.messages.create / channel.leave live-broadcast pattern above:
            // resource::dispatch only holds `db`, so the fanout tick is emitted here
            // at the WS boundary. Data-free — clients re-fetch via their own authz'd
            // fs.ls/fs.read. board name "files" (cross-slice contract).
            if matches!(
                frame.get("resource").and_then(Value::as_str),
                Some("fs.write" | "fs.edit" | "fs.append" | "fs.rm" | "fs.mv")
            ) && resp.get("ok").and_then(Value::as_bool) == Some(true)
            {
                if let Some(cid) = resp
                    .get("data")
                    .and_then(|d| d.get("channel_id"))
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse::<Uuid>().ok())
                {
                    let wire = WireFrame::channel(
                        cid,
                        "board_signal",
                        json!({ "channel_id": cid, "board": "files" }),
                    );
                    state.fanout.broadcast_channel(cid, wire).await;
                }
            }
            // Agent wrote its own status card (`bot.status.write`, the set_status
            // tool): persisted in dispatch (db-only); the live member_updated push
            // to every channel the bot is in needs the fanout, so it's emitted
            // here at the WS boundary — same pattern as the blocks above.
            if frame.get("resource").and_then(Value::as_str) == Some("bot.status.write")
                && resp.get("ok").and_then(Value::as_bool) == Some(true)
            {
                crate::api::bots::broadcast_bot_member_update(state, &bot.bot_id.to_string()).await;
                // Traceability (audit items 3 + 9): record the self-status write to
                // acp_event_log so status changes are auditable alongside every other
                // ACP event. Summary ONLY — which fields were set and their char
                // lengths, NEVER the text itself. channel_id is NULL (a self-card write
                // isn't channel-scoped); session_id rides the frame if present.
                // Best-effort: a log-write failure must never disrupt the live agent.
                let params = frame.get("params");
                let field_len = |key: &str| {
                    params
                        .and_then(|p| p.get(key))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|s| s.chars().count())
                };
                let audit_payload = json!({
                    "status_text_len": field_len("status_text"),
                    "status_emoji_len": field_len("status_emoji"),
                    "info_len": field_len("info"),
                });
                if let Err(err) = sqlx::query(
                    "INSERT INTO acp_event_log (id, bot_id, channel_id, session_id, name, home, payload)
                     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
                )
                .bind(Uuid::new_v4().to_string())
                .bind(bot.bot_id.to_string())
                .bind(Option::<&str>::None)
                .bind(frame.get("session_id").and_then(Value::as_str))
                .bind("bot.status.write")
                .bind("cheers")
                .bind(audit_payload.to_string())
                .execute(&state.db)
                .await
                {
                    tracing::warn!(bot_id = %bot.bot_id, error = %err, "bot.status.write audit log write failed");
                }
            }
            // resource_res 发回给 bot（通过同一条 data WS）
            let _ = ws_send(socket, &resp).await;
        }

        // ── 远程工作区 RPC 响应（connector → gateway，按 req_id 关联）──────────
        "workspace_res" => {
            if let Some(req_id) = frame.get("req_id").and_then(Value::as_str) {
                state.workspace_rpc.resolve(req_id, frame.clone());
            }
        }

        // ── 远程工作区文件变更推送（connector → gateway，主动 push）──────────
        // The connector's live watcher fires `{root, paths, kind}` when watched
        // files change. The frame is bot-scoped (this WS is authenticated as the
        // bot), so fan a signal-only `workspace_signal{bot_id, root, paths}` to every
        // channel the bot is a member of — recipients re-pull via their own authz'd
        // workspace REST reads (no file content crosses here). Mirrors the
        // board_signal / trace validated-then-fanned pattern.
        "workspace_event" => {
            handle_workspace_event_frame(frame, state, bot).await;
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
        // ── 审批终态（超时/取消，连接器本地裁决后通知，避免卡片永久 pending）──
        "permission_cancel" => {
            handle_permission_cancel_frame(frame, state, bot).await;
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
            let _ = ws_send(socket, &bridge_frames::pong_frame()).await;
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
            let _ = ws_send(socket, &bridge_frames::resume_ack_frame(up_to_seq)).await;
        }

        // ── agent 进度（trace）：记录 + 转发给浏览器，让 UI 显示「思考中」状态 ──
        "trace" => {
            handle_trace_frame(frame, state, bot).await;
        }

        // ── generic ACP event passthrough (docs/arch/ACP_EVENT_TAXONOMY.md) ──
        // The connector forwards every ACP session/update verbatim; classify via
        // the acp_events registry and record to acp_event_log (skip streaming chunks).
        "acp_event" => {
            handle_acp_event_frame(frame, state, bot).await;
        }

        other => {
            tracing::debug!(bot_id = %bot.bot_id, frame_type = other, "unknown data frame");
        }
    }
}

/// Persist a generic ACP event (the complete-stream passthrough). Best-effort:
/// a log-write failure must never disrupt the live agent. Streaming text chunks
/// are dropped here (the bot's message already carries the text).
async fn handle_acp_event_frame(frame: &Value, state: &AppState, bot: &BotInfo) {
    let name = frame
        .get("name")
        .or_else(|| frame.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if name.is_empty() || !crate::domain::acp_events::should_log(name) {
        return;
    }
    let home = crate::domain::acp_events::classify(name)
        .map(|e| e.home.as_str())
        .unwrap_or("");
    let payload = frame.get("payload").cloned().unwrap_or(Value::Null);
    if let Err(err) = sqlx::query(
        "INSERT INTO acp_event_log (id, bot_id, channel_id, session_id, name, home, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(bot.bot_id.to_string())
    .bind(frame.get("channel_id").and_then(Value::as_str))
    .bind(frame.get("session_id").and_then(Value::as_str))
    .bind(name)
    .bind(home)
    .bind(payload.to_string())
    .execute(&state.db)
    .await
    {
        tracing::warn!(bot_id = %bot.bot_id, %name, error = %err, "acp_event log write failed");
    }

    // ── Phase A: promote the three artifact updates (plan / usage / available
    // commands) into typed, queryable storage. The parse layer is shared
    // (domain::acp_session_updates); each store is per-feature and best-effort —
    // it swallows its own errors so the live turn is never disrupted. ──
    if let Some(parsed) = crate::domain::acp_session_updates::parse(name, &payload) {
        use crate::domain::acp_session_updates::ParsedUpdate;
        let channel_id = frame.get("channel_id").and_then(Value::as_str);
        let session_id = frame.get("session_id").and_then(Value::as_str);
        let bot_id = bot.bot_id.to_string();
        // Which ViewBoard this update feeds (for the live-push nudge below).
        let board = match &parsed {
            ParsedUpdate::AvailableCommands(_) => "commands",
            ParsedUpdate::Plan(_) => "plan",
            ParsedUpdate::Usage(_) => "cost",
        };
        match parsed {
            ParsedUpdate::AvailableCommands(ac) => {
                crate::domain::commands_store::record(
                    &state.db, channel_id, &bot_id, session_id, &ac,
                )
                .await
            }
            ParsedUpdate::Plan(p) => {
                crate::domain::plan_store::record(&state.db, channel_id, &bot_id, session_id, &p)
                    .await
            }
            ParsedUpdate::Usage(u) => {
                crate::domain::usage_store::record(&state.db, channel_id, &bot_id, session_id, &u)
                    .await
            }
        }
        // Live-push: nudge the channel's ViewBoards to re-pull. These board events
        // don't otherwise fan out to browsers (DECENTRALIZED_MESH §6: realtime is
        // conversational-only), so the board is pull-only without this signal. The
        // frame carries no data — boards re-fetch via their own authz'd *.read verb.
        if let Some(cid) = channel_id.and_then(|s| s.parse::<Uuid>().ok()) {
            let wire = WireFrame::channel(
                cid,
                "board_signal",
                json!({ "channel_id": cid, "board": board }),
            );
            state.fanout.broadcast_channel(cid, wire).await;
        }
    }
}

/// 记录 agent 进度（trace）并 fan-out 一个 `bot_trace` 帧给频道内浏览器。
/// trace 非终态帧，队列满时可丢弃（下一条 trace 或 message_done 会覆盖状态）。
async fn handle_trace_frame(frame: &Value, state: &AppState, bot: &BotInfo) {
    let msg_id = frame.get("msg_id").and_then(Value::as_str);
    let phase = frame.get("phase").and_then(Value::as_str);
    let status = frame.get("status").and_then(Value::as_str);
    let title = frame.get("title").and_then(Value::as_str);

    tracing::info!(
        bot_id = %bot.bot_id,
        msg_id = msg_id.unwrap_or(""),
        phase = phase.unwrap_or(""),
        status = status.unwrap_or(""),
        title = title.unwrap_or(""),
        "agent trace"
    );

    let Some(channel_id) = frame
        .get("channel_id")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<Uuid>().ok())
    else {
        return;
    };

    // The channel_id is bot-supplied and must not be trusted: only forward
    // progress into channels the bot is actually a member of (mirrors the
    // delta/done/send/permission_request handlers). Otherwise a self-registered
    // bot could spoof agent-progress text into arbitrary channels.
    if ensure_bot_channel_member(&state.db, bot.bot_id, channel_id)
        .await
        .is_err()
    {
        return;
    }

    // Persist the trace durably (best-effort, fire-and-forget — never .await
    // before the live fan-out below, so a slow DB can't backpressure the
    // connector frame loop). The write-time allowlist thins high-frequency rows;
    // kind='approval' is always kept. docs/arch/TRACE_PERSISTENCE.md.
    if let Some(mid) = msg_id {
        let phase_s = phase.unwrap_or("").to_string();
        let kind: &'static str = if phase_s == "approval" {
            "approval"
        } else {
            "trace"
        };
        if crate::domain::trace::should_persist(kind, &phase_s) {
            let ev = crate::domain::trace::TraceEvent {
                msg_id: mid.to_string(),
                channel_id: channel_id.to_string(),
                bot_id: Some(bot.bot_id.to_string()),
                task_id: frame
                    .get("task_id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                run_id: frame
                    .get("run_id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                stream: frame
                    .get("stream")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                kind,
                phase: phase_s,
                status: status.map(str::to_string),
                title: title.map(str::to_string),
                message: frame
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                data: frame.get("data").cloned(),
                request_id: frame
                    .get("request_id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                approval_kind: frame
                    .get("data")
                    .and_then(|d| d.get("approval_kind"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                ..Default::default()
            };
            let db = state.db.clone();
            tokio::spawn(async move {
                if let Err(err) = crate::domain::trace::record(&db, ev).await {
                    tracing::warn!(error = %err, "message_traces persist failed");
                }
            });
        }
    }

    let wire = WireFrame::channel(
        channel_id,
        "bot_trace",
        json!({
            "msg_id": msg_id,
            "channel_id": channel_id,
            "phase": phase,
            "status": status,
            "title": title,
            "message": frame.get("message").and_then(Value::as_str),
        }),
    );
    // Live per-subscriber SEE (docs/arch/ACP_EVENT_TAXONOMY.md): the bot's internal
    // activity is gated by SEE(tool_call); approval traces by SEE(permission_request).
    // Members an owner denied SEE for don't receive the live frame.
    let see_class = if phase == Some("approval") {
        crate::domain::bot_event_policy::EV_PERMISSION_REQUEST
    } else {
        crate::domain::bot_event_policy::EV_TOOL_CALL
    };
    let allowed = allowed_seers(state, bot.bot_id, channel_id, see_class).await;
    state
        .fanout
        .broadcast_channel_to_users(channel_id, wire, allowed)
        .await;
}

/// Live per-subscriber SEE (docs/arch/ACP_EVENT_TAXONOMY.md): the online channel
/// users allowed to SEE an agent event of `event_class` for `bot`. Platform admins
/// bypass; absent rules → members allowed (the default). Fail-open on a rules error
/// (return everyone online) so a query hiccup never *hides* the bot's activity.
async fn allowed_seers(
    state: &AppState,
    bot_id: Uuid,
    channel_id: Uuid,
    event_class: &str,
) -> Vec<Uuid> {
    let online = state.fanout.online_users(channel_id);
    if online.is_empty() {
        return Vec::new();
    }
    let rules =
        match crate::domain::bot_event_policy::load_rules(&state.db, &bot_id.to_string()).await {
            Ok(r) => r,
            Err(_) => return online,
        };
    // Fast path: `resolve_access` for `See` only ever consults `see`-capability rules
    // for this event_class, and the membership default for `See` is always allow. So
    // with no matching `see` rule, everyone online is a seer — skip the channel-role
    // query and the per-online-user `matched_groups` probes entirely (the common case).
    if !rules.iter().any(|r| {
        r.event_class == event_class
            && r.capability == crate::domain::bot_event_policy::Capability::See.as_str()
    }) {
        return online;
    }
    let mut chan_role: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut platform_admin: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Ok(rows) = sqlx::query(
        "SELECT cm.member_id, cm.role AS crole, u.role AS prole
         FROM channel_memberships cm JOIN users u ON u.user_id = cm.member_id
         WHERE cm.channel_id = $1 AND cm.member_type = 'user'",
    )
    .bind(channel_id.to_string())
    .fetch_all(&state.db)
    .await
    {
        for r in rows {
            let mid: String = r.try_get("member_id").unwrap_or_default();
            if let Ok(Some(c)) = r.try_get::<Option<String>, _>("crole") {
                chan_role.insert(mid.clone(), c);
            }
            if matches!(
                r.try_get::<Option<String>, _>("prole")
                    .ok()
                    .flatten()
                    .as_deref(),
                Some("system_admin") | Some("admin")
            ) {
                platform_admin.insert(mid);
            }
        }
    }
    let bot_s = bot_id.to_string();
    let chan_s = channel_id.to_string();
    let mut out = Vec::new();
    for uid in online {
        let id = uid.to_string();
        if platform_admin.contains(&id) {
            out.push(uid);
            continue;
        }
        let role = chan_role.get(&id).map(String::as_str).unwrap_or("member");
        let groups =
            crate::domain::bot_event_policy::matched_groups(&state.db, &bot_s, &id, &rules).await;
        if crate::domain::bot_event_policy::resolve_access(
            &rules,
            &chan_s,
            &id,
            role,
            &groups,
            event_class,
            crate::domain::bot_event_policy::Capability::See,
        ) {
            out.push(uid);
        }
    }
    out
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
            // Turn-complete workspace freshness: the turn just finalized. If this
            // bot is workspace-capable (its connector is online), it may have
            // mutated its Desk during the turn — emit one data-free tick so any open
            // workspace view re-pulls. board name "workspace" (cross-slice contract);
            // clients re-fetch via their own authz'd reads. channel_id is re-derived
            // from the (now finalized, bot-owned) msg_id — handle_done already
            // verified ownership but consumes the channel_id internally.
            if let Some(mid) = msg_id {
                if state.bot_locator.is_online(bot.bot_id).await {
                    if let Some(cid) = channel_of_bot_message(&state.db, bot.bot_id, mid).await {
                        let wire = WireFrame::channel(
                            cid,
                            "board_signal",
                            json!({
                                "channel_id": cid,
                                "board": "workspace",
                                "bot_id": bot.bot_id,
                            }),
                        );
                        state.fanout.broadcast_channel(cid, wire).await;
                    }
                }
            }
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

    // The agent decides WHEN to ask (its mode); Cheers always surfaces the ask as a
    // pending card and routes the answer to RESPOND-authorized users (see
    // docs/arch/ACP_EVENT_TAXONOMY.md). No per-tool-kind auto-answer here.
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

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(crate::gateway::log_db_err("permission_request: begin tx"))?;
    let channel_seq =
        channel_seq::allocate(&mut tx, channel_id)
            .await
            .map_err(crate::gateway::log_db_err(
                "permission_request: allocate channel_seq",
            ))?;
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
    .map_err(crate::gateway::log_db_err(
        "permission_request: insert message",
    ))?;
    tx.commit()
        .await
        .map_err(crate::gateway::log_db_err("permission_request: commit tx"))?;

    // Audit the request itself so `approval_audit` holds the full
    // requested → resolved/timeout chain in one place (resolve and timeout are
    // already audited; this closes the gap at card creation). Best-effort: an
    // audit-write failure must not block the user-visible card.
    if let Err(err) = crate::domain::approval::record_audit(
        &state.db,
        crate::domain::approval::AuditEvent {
            event_type: "requested",
            bot_id: Some(bot.bot_id),
            channel_id,
            request_id: frame
                .get("request_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            msg_id: Some(msg_id),
            detail: Some(json!({
                "title": title,
                "tool": frame.get("tool").cloned().unwrap_or(Value::Null),
            })),
            ..Default::default()
        },
    )
    .await
    {
        tracing::warn!(%channel_id, error = %err, "permission_request: audit write failed");
    }

    // Mirror the request into the durable trace timeline as an approval event,
    // anchored to the BOT TURN (source_msg_id, = frame.msg_id) — NOT the
    // permission card's own msg_id — so it interleaves with that turn's
    // tool_call/plan traces. Best-effort, after the legal audit write.
    let trace_anchor = frame
        .get("msg_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| msg_id.to_string());
    if let Err(err) = crate::domain::trace::record(
        &state.db,
        crate::domain::trace::TraceEvent {
            msg_id: trace_anchor,
            channel_id: channel_id.to_string(),
            bot_id: Some(bot.bot_id.to_string()),
            kind: "approval",
            phase: "approval".to_string(),
            status: Some("pending".to_string()),
            title: Some(title.to_string()),
            message: Some(body.to_string()),
            data: Some(json!({ "tool": frame.get("tool").cloned().unwrap_or(Value::Null) })),
            request_id: frame
                .get("request_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            approval_kind: Some("requested".to_string()),
            ..Default::default()
        },
    )
    .await
    {
        tracing::warn!(%channel_id, error = %err, "permission_request: trace write failed");
    }

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
    // Live per-subscriber SEE: only members allowed to SEE permission_request get
    // the card frame (RESPOND still separately gates who may *answer* it).
    let allowed = allowed_seers(
        state,
        bot.bot_id,
        channel_id,
        crate::domain::bot_event_policy::EV_PERMISSION_REQUEST,
    )
    .await;
    state
        .fanout
        .broadcast_channel_to_users(channel_id, wire, allowed)
        .await;

    Ok(msg_id)
}

/// Finalize a still-pending approval card after the connector reported the ACP
/// request reached a terminal state locally (timeout / cancel) with no human
/// decision. Idempotent: skips cards already resolved by a human.
async fn handle_permission_cancel_frame(frame: &Value, state: &AppState, bot: &BotInfo) {
    let Some(request_id) = frame.get("request_id").and_then(Value::as_str) else {
        return;
    };
    let reason = frame
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("timeout");

    let pending =
        match crate::domain::approval::find_pending_by_request_id(&state.db, request_id).await {
            Ok(Some(p)) => p,
            Ok(None) => return, // never forwarded, or already swept
            Err(e) => {
                tracing::warn!(error = %e, request_id, "permission_cancel: lookup failed");
                return;
            }
        };
    // Only this bot's own requests; and skip if a human already resolved it.
    if pending.bot_id != bot.bot_id
        || pending
            .content_data
            .get("resolved")
            .and_then(Value::as_bool)
            == Some(true)
    {
        return;
    }

    // Shared finalize (atomic CAS + audit + trace + broadcast); identical to the
    // server-side TTL sweeper so the two paths can never diverge.
    if crate::gateway::approval_sweeper::finalize_expired(
        &state.db,
        &state.fanout,
        &pending,
        reason,
    )
    .await
    {
        tracing::info!(request_id, reason, "permission card finalized as expired");
    }
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
    .map_err(crate::gateway::log_db_err(
        "ensure_bot_channel_member: select membership exists",
    ))?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);

    if is_member {
        Ok(())
    } else {
        Err("bot is not a member of the target channel")
    }
}

/// Resolve the channel a bot's message belongs to (bot-scoped). Used post-`handle_done`
/// to target the turn-complete `board_signal`: `handle_done` already verified the bot
/// owns `msg_id` but consumes its channel_id internally, and the message is now
/// finalized (so `verify_ownership` can no longer be reused), so we re-derive it here.
async fn channel_of_bot_message(db: &PgPool, bot_id: Uuid, msg_id: Uuid) -> Option<Uuid> {
    sqlx::query(
        "SELECT channel_id FROM messages
         WHERE msg_id = $1 AND sender_id = $2 AND sender_type = 'bot'",
    )
    .bind(msg_id.to_string())
    .bind(bot_id.to_string())
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .and_then(|row| row.try_get::<String, _>("channel_id").ok())
    .and_then(|s| s.parse::<Uuid>().ok())
}

fn client_msg_id(frame: &Value) -> Option<String> {
    frame
        .get("client_msg_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

// send_ack / terminal_ack / error constructors live in gateway::bridge_frames
// so their bytes are pinned by the shared golden fixtures.

fn server_capabilities(state: &AppState) -> Value {
    let mut caps = json!({
        "auth": ["authorization_bearer", "auth_frame"],
        "task_stream": "control",
        "runtime_session_control": true,
        "resource_req": true,
        "send_ack": true,
        "terminal_ack": true,
        "resume": "ack_only",
        "file_upload": false,
        "acp_security": true,
    });
    // Advertise the release version this gateway serves via its download proxy
    // so an opted-in connector can self-update. Absent when the operator pins
    // nothing (proxy then tracks "latest", whose version the gateway can't know
    // without polling GitHub — connectors treat absence as "no update signal").
    if let Some(v) = &state.config.connector_release_version {
        caps["latest_connector_version"] = json!(v);
    }
    caps
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

                // Protocol negotiation, checked BEFORE the token hits the DB: the
                // auth frame states the connector's bridge protocol version
                // (absent ⇒ v1, the legacy default). Reject anything else with a
                // 4400 close whose reason names the supported version — the
                // connector-facing half of the handshake; the connector already
                // strictly validates the gateway's hello (ensure_supported_version).
                // NOTE: header-Bearer auth carries no auth frame; those connectors
                // are covered by their own hello-side check.
                let peer_version = frame
                    .get("bridge_protocol_version")
                    .or_else(|| frame.get("v"))
                    .and_then(Value::as_u64)
                    .unwrap_or(BRIDGE_PROTOCOL_VERSION as u64);
                if peer_version != BRIDGE_PROTOCOL_VERSION as u64 {
                    tracing::warn!(
                        version = peer_version,
                        connector = ?frame.get("connector"),
                        "rejecting connector with unsupported bridge protocol version"
                    );
                    close(
                        socket,
                        CLOSE_PROTOCOL_ERROR,
                        &format!(
                            "unsupported bridge protocol version {peer_version}; supported: {BRIDGE_PROTOCOL_VERSION}"
                        ),
                    )
                    .await;
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
        "SELECT bot_id, username, display_name, is_disabled, binding_config, created_by
         FROM bot_accounts WHERE bot_token_hash = $1",
    )
    .bind(&token_hash)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .ok_or(AuthFailure::InvalidToken)?;

    // Admin kill-switch: a disabled bot may not establish the bridge, so a kicked
    // connector can't immediately reconnect.
    let is_disabled: bool = row.try_get("is_disabled").unwrap_or(false);
    if is_disabled {
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
    // H6 (non-breaking): honor an explicit require_capability, else enforce only
    // when the bot has an active capability delegation. A bot that never opted
    // into signed capabilities keeps working with an unsigned data plane.
    let require_capability = match resolve_bot_require_capability(binding_config.as_ref()) {
        Some(explicit) => explicit,
        None => bot_has_active_delegation(db, &bot_id).await,
    };
    Ok(BotInfo {
        bot_id,
        provider_account_id,
        username: row.try_get("username").unwrap_or_default(),
        display_name: row.try_get("display_name").ok(),
        require_capability,
        acp_security: resolve_bot_acp_security(binding_config.as_ref()),
        connector_config: resolve_bot_connector_config(binding_config.as_ref()),
        owner_id: row
            .try_get::<Option<String>, _>("created_by")
            .ok()
            .flatten(),
    })
}

/// Explicit `acp_security.require_capability` setting, or None when unset. When
/// None the gateway defaults to "enforce iff the bot has an active capability
/// delegation" (see resolve_bot): bots that opted into signed capabilities are
/// fail-closed, bots that never did keep working unsigned (audit H6,
/// non-breaking rollout).
fn resolve_bot_require_capability(binding_config: Option<&Value>) -> Option<bool> {
    binding_config
        .and_then(|cfg| cfg.get("acp_security"))
        .and_then(|acp| acp.get("require_capability"))
        .and_then(Value::as_bool)
}

/// Whether a bot has at least one active (non-revoked, in-status, non-expired,
/// not uses-exhausted) capability delegation.
async fn bot_has_active_delegation(db: &PgPool, bot_id: &Uuid) -> bool {
    sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM acp_capability_delegations
            WHERE bot_id = $1
              AND revoked = FALSE
              AND status = 'active'
              AND (expires_at IS NULL OR expires_at > NOW())
              AND (max_uses IS NULL OR use_count < max_uses)
        ) AS ok",
    )
    .bind(bot_id.to_string())
    .fetch_one(db)
    .await
    .ok()
    .and_then(|row| row.try_get::<bool, _>("ok").ok())
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

/// Broker a `workspace.read` resource pull for a reader bot (unified context model,
/// P3-2). The bundle reference names the OWNER bot + path + the channel it was shared
/// in; `read_workspace_file_as_bot` enforces channel membership + the `workspace_read`
/// grant, then reuses the identity-free workspace RPC to fetch the current file. Maps
/// `AppError` back to a `resource_res` frame exactly like `resource::dispatch`, so the
/// connector sees the same reply shape as every other verb. A `workspace.read` ref thus
/// resolves under the reader's OWN read permission (superseding the inline snapshot).
async fn broker_workspace_read(state: &AppState, reader_bot_id: Uuid, frame: &Value) -> Value {
    let req_id = frame.get("req_id").and_then(Value::as_str).unwrap_or("");
    let params = frame.get("params").cloned().unwrap_or(Value::Null);
    let str_param = |k: &str| {
        params
            .get(k)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let uuid_param = |k: &str| str_param(k).and_then(|s| Uuid::parse_str(&s).ok());

    let Some(owner_bot_id) = uuid_param("bot_id") else {
        return bridge_frames::resource_res_err(req_id, "INVALID_PARAMS", "bot_id required");
    };
    let Some(channel_id) = uuid_param("channel_id") else {
        return bridge_frames::resource_res_err(req_id, "INVALID_PARAMS", "channel_id required");
    };
    let Some(path) = str_param("path") else {
        return bridge_frames::resource_res_err(req_id, "INVALID_PARAMS", "path required");
    };
    let session_id = uuid_param("session_id");
    // The root the ref's `path` is relative to (from the picker's `treeRoot`). Without
    // it the read falls back to the connector's default cwd / first allowed root, which
    // can resolve a different same-named file — so pass it through when present.
    let root = str_param("root");

    match crate::api::workspace::read_workspace_file_as_bot(
        state,
        owner_bot_id,
        reader_bot_id,
        channel_id,
        &path,
        root.as_deref(),
        session_id,
    )
    .await
    {
        Ok(data) => bridge_frames::resource_res_ok(req_id, data),
        Err(e) => {
            let (code, msg) = app_error_to_resource(&e);
            bridge_frames::resource_res_err(req_id, code, &msg)
        }
    }
}

/// Map an `AppError` from the workspace broker to a `resource_res` (code, message)
/// pair, mirroring the code space `resource::dispatch` / `workspace_call` already use
/// (`E_CONFLICT`, `E_TOO_LARGE`, `PERMISSION_DENIED`, …). Internal errors are opaque.
fn app_error_to_resource(e: &crate::errors::AppError) -> (&'static str, String) {
    use crate::errors::AppError;
    match e {
        AppError::Forbidden(m) => ("PERMISSION_DENIED", m.clone()),
        AppError::NotFound => ("NOT_FOUND", "not found".to_string()),
        AppError::BadRequest(m) => ("INVALID_PARAMS", m.clone()),
        AppError::Conflict(m) => ("E_CONFLICT", m.clone()),
        AppError::PayloadTooLarge(m) => ("E_TOO_LARGE", m.clone()),
        _ => ("INTERNAL_ERROR", "internal error".to_string()),
    }
}

/// Fan the connector's `workspace_event` file-change push out to browsers as a
/// signal-only `workspace_signal` frame. The frame is bot-scoped (the WS is already
/// authenticated as `bot`), so we look up every channel the bot belongs to and
/// broadcast `{bot_id, root, paths}` — no file content, recipients re-fetch through
/// their own authorized workspace REST reads. `kind` is advisory only.
async fn handle_workspace_event_frame(frame: &Value, state: &AppState, bot: &BotInfo) {
    let root = frame.get("root").cloned().unwrap_or(Value::Null);
    let paths = frame.get("paths").cloned().unwrap_or_else(|| json!([]));

    let channels: Vec<Uuid> = sqlx::query_scalar::<_, String>(
        "SELECT channel_id FROM channel_memberships
         WHERE member_id = $1 AND member_type = 'bot'",
    )
    .bind(bot.bot_id.to_string())
    .fetch_all(&state.db)
    .await
    .unwrap_or_default()
    .into_iter()
    .filter_map(|s| Uuid::parse_str(&s).ok())
    .collect();

    for cid in channels {
        let wire = WireFrame::channel(
            cid,
            "workspace_signal",
            json!({
                "bot_id": bot.bot_id.to_string(),
                "root": root,
                "paths": paths,
            }),
        );
        state.fanout.broadcast_channel(cid, wire).await;
    }
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

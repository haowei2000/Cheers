use std::collections::{HashMap, HashSet};
/// 消息领域逻辑。
///
/// 核心流程（写后投递原则）：
///   1. 验写权限、屏蔽、consent 与目标 bot
///   2. INSERT message + chosen sessions/chain/dispatch intents → PG (one tx)
///   3. fanout::broadcast（终态帧，先落库再投递）
///   4. Offer the committed intents through the shared durable delivery path
use std::sync::Arc;

use chrono::Utc;
use serde_json::json;
use sqlx::{PgPool, Postgres, Transaction};
use tracing::{debug, info};
use uuid::Uuid;

use crate::{
    domain::{
        channel_seq,
        mentions::{self, MentionParseError},
        sessions,
    },
    errors::AppError,
    gateway::{
        dispatch_intents::{self, HumanIntent},
        dispatcher::DispatchParams,
        realtime::{fanout::Fanout, frame::WireFrame},
        registry::BotLocator,
        stream::StreamRegistry,
    },
    infra::db::models::{MessageDto, MessageFileRef, MessageMention, MESSAGE_SCHEMA_VERSION},
};

pub(crate) fn interactive_request_key(
    params: &CreateMessageParams,
) -> Result<Option<crate::resource::idempotency::IdempotencyKey>, AppError> {
    let key = if let Some(event) = params
        .context_bundle
        .as_ref()
        .and_then(|b| b.get("interaction"))
    {
        crate::resource::idempotency::IdempotencyKey::from_params(
            &crate::resource::Principal::user(params.user_id), "ui.request",
            &json!({"idempotency_key":event["invocationId"],"channel_id":params.channel_id,
                "content":params.content,"msg_type":params.msg_type.as_deref().unwrap_or("text"),"context_bundle":params.context_bundle,
                "mention_ids":params.mention_ids,"mention_names":params.mention_names,
                "file_ids":params.file_ids,"reply_to_msg_id":params.reply_to_msg_id,"session_id":params.session_id})
        ).map_err(|(_, message)| AppError::Conflict(message))?
    } else {
        None
    };
    Ok(key)
}

// ── create_message ────────────────────────────────────────────────────────────

pub struct CreateMessageParams {
    pub user_id: Uuid,
    pub channel_id: Uuid,
    pub content: String,
    pub msg_type: Option<String>,
    pub reply_to_msg_id: Option<Uuid>,
    pub file_ids: Vec<String>,
    pub mention_ids: Vec<Uuid>,
    /// @mentions by username / display_name / group token (`@all`, `@bots`,
    /// `@humans`, `@here`). Resolved server-side via the same
    /// [`mentions::resolve_mention_names`] path bots use, so humans and bots
    /// share one group-mention protocol. Merged with `mention_ids` (deduped).
    pub mention_names: Vec<String>,
    /// Target a specific "other" session (else the channel's primary). Must be a
    /// session bound to this channel; it determines which bot is prompted.
    pub session_id: Option<Uuid>,
    /// Optional resource-context bundle attached to this message
    /// (docs/design/RESOURCE_CONTEXT.md). Persisted on the row and threaded into
    /// any triggered bot's task frame via `dispatcher::load_task_context`.
    pub context_bundle: Option<serde_json::Value>,
    /// Pre-chosen message id, for a caller that must be able to retry safely.
    ///
    /// Inbound integration events are the case this exists for: the delivery
    /// worker derives a v5 uuid from the provider's own delivery id, so a retry
    /// after a crash collides on `messages_pkey` instead of posting the event a
    /// second time. Every other caller passes `None` and gets a fresh v4.
    pub msg_id: Option<Uuid>,
}

pub async fn create_message(
    db: &PgPool,
    fanout: &Arc<dyn Fanout>,
    stream_registry: &StreamRegistry,
    bot_locator: &Arc<dyn BotLocator>,
    mut params: CreateMessageParams,
) -> Result<MessageDto, AppError> {
    info!(user_id = %params.user_id, channel_id = %params.channel_id, "create_message start");

    let sender_role =
        super::message_policy::authorize_human_send(db, params.user_id, params.channel_id).await?;
    if params.content.trim().is_empty() {
        return Err(AppError::BadRequest("content cannot be empty".into()));
    }
    if let Some(event) = params
        .context_bundle
        .as_ref()
        .and_then(|bundle| bundle.get("interaction"))
    {
        cheers_mcp_server::interactive::validate_interaction(event)
            .map_err(|error| AppError::BadRequest(error.into()))?;
    }
    params.context_bundle = params
        .context_bundle
        .as_ref()
        .and_then(super::context_bundle::sanitize_human_bundle);
    let file_ids = normalize_file_ids(&params.file_ids);
    if !file_ids.is_empty() {
        validate_file_ids(db, params.user_id, params.channel_id, &file_ids).await?;
    }

    // Names first (group tokens like @all/@bots expand here — the same path bots
    // use via post_message), then the explicit ids, merged & deduped. A human
    // @all is a deliberate one-shot fan-out (no amplification), bounded by the
    // GROUP_MENTION_CAP in resolve_mention_names — no per-channel budget here
    // (that guards *amplifying* bot→bot chains, and would wrongly throttle normal
    // 1:1 human↔bot chat).
    let mut mentions =
        mentions::resolve_mention_names(db, params.channel_id, &params.mention_names)
            .await
            .map_err(mention_parse_error_to_app)?;
    let id_mentions = mentions::validate_mention_ids(db, params.channel_id, &params.mention_ids)
        .await
        .map_err(mention_parse_error_to_app)?;
    for m in id_mentions {
        if !mentions
            .iter()
            .any(|x| x.member_id == m.member_id && x.member_type == m.member_type)
        {
            mentions.push(m);
        }
    }
    debug!(channel_id = %params.channel_id, mentions = mentions.len(), "mentions resolved (names + ids)");

    let targeted_session = match params.session_id {
        Some(sid) => {
            let (bot, _) =
                sessions::resolve_channel_session(db, &params.channel_id.to_string(), sid)
                    .await
                    .map_err(|error| match error {
                        AppError::NotFound => {
                            AppError::BadRequest("session not found in this channel".into())
                        }
                        error => error,
                    })?;
            Some((bot, sid))
        }
        None => None,
    };
    let bots = match &targeted_session {
        Some((bot, _)) => vec![*bot],
        None => {
            resolve_bot_triggers(db, params.channel_id, &mentions, params.reply_to_msg_id).await?
        }
    };
    // readonly 角色的 bot 不派发：它在 resource 层本就发不出消息，唤醒只会
    // 产生一个必然失败的回合。消息本身照常入库。
    let bots = filter_writable_bots(db, params.channel_id, bots).await?;
    let bots = super::message_policy::filter_prompt_bots(
        db,
        params.user_id,
        params.channel_id,
        &sender_role,
        bots,
    )
    .await?;
    super::message_policy::ensure_bot_consents(
        db,
        &params.user_id.to_string(),
        params.channel_id,
        &bots,
    )
    .await?;

    // UI requests are ordinary human messages with a structured context envelope.
    // Claim their invocation id in the SAME transaction as the message, reusing
    // the existing idempotency protocol instead of a second action/job store.
    let idempotency = interactive_request_key(&params)?;
    if let Some(key) = &idempotency {
        if let Some(result) = key
            .replay(db)
            .await
            .map_err(|(_, message)| AppError::Conflict(message))?
        {
            return serde_json::from_value(result)
                .map_err(|error| AppError::Internal(error.to_string()));
        }
    }

    // A replay retains its accepted receipt after a source edit or bot disconnect,
    // but current membership, blocking, and consent still apply above.
    if let Some(event) = params
        .context_bundle
        .as_ref()
        .and_then(|bundle| bundle.get("interaction"))
    {
        super::message_policy::validate_resource_interaction(db, &params, event).await?;
    }

    let author = sqlx::query!(
        "SELECT display_name, username FROM users WHERE user_id = $1",
        params.user_id.to_string(),
    )
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::Forbidden("message author is not active".into()))?;
    let trigger_sender_name = author
        .display_name
        .as_ref()
        .filter(|name| !name.is_empty())
        .cloned()
        .unwrap_or(author.username);
    let sender_name = author.display_name;

    // A human @mention is a request to start work, not merely decorative text.
    // Reject before allocating a sequence or persisting anything when its target
    // bot cannot receive a task. This keeps a failed trigger out of every
    // client's timeline instead of creating a message that no bot can answer.
    // Only an eligible dispatch target can reject a human send. In particular,
    // readonly bot members are intentionally not woken, so @all must still post
    // when one of those passive members is offline.
    let mentioned_bots: HashSet<Uuid> = mentions
        .iter()
        .filter(|mention| matches!(mention.member_type, mentions::MemberType::Bot))
        .map(|mention| mention.member_id)
        .chain(targeted_session.iter().map(|(bot, _)| *bot))
        .collect();
    let mut has_offline_target = false;
    let mut has_unready_target = false;
    let mut admitted_bots = Vec::with_capacity(bots.len());
    for bot_id in bots {
        if !bot_locator.is_online(bot_id).await {
            has_offline_target |= mentioned_bots.contains(&bot_id);
        } else if !bot_locator.supports_task_acceptance(bot_id).await {
            has_unready_target |= mentioned_bots.contains(&bot_id);
        } else {
            admitted_bots.push(bot_id);
        }
    }
    if has_offline_target {
        return Err(AppError::Conflict(
            "the mentioned bot is currently offline".into(),
        ));
    }
    if has_unready_target {
        return Err(AppError::Conflict(
            "the mentioned bot is not ready to accept tasks; reconnect or upgrade its connector"
                .into(),
        ));
    }
    // Automatic/default targets keep their best-effort admission semantics:
    // only a currently ready bot receives an intent. Once admitted, a later
    // disconnect is recoverable without changing this accepted target set.
    let mut targets = Vec::with_capacity(admitted_bots.len());
    for bot_id in admitted_bots {
        let bundle = match &params.context_bundle {
            Some(bundle) => Some(
                crate::domain::context_bundle::finalize_bundle_for_target(
                    db,
                    bundle,
                    crate::resource::Principal::bot(bot_id),
                    params.channel_id,
                )
                .await,
            ),
            None => None,
        };
        targets.push((bot_id, bundle));
    }
    let msg_id = params.msg_id.unwrap_or_else(Uuid::new_v4);
    let msg_type = params.msg_type.as_deref().unwrap_or("text");
    let now = Utc::now();

    // Member-facing copy: strip inline snapshots so `preview.text` never reaches
    // channel members / history (they only ever see chip labels). The full copy —
    // `params.context_bundle`, already sanitized by the shared message
    // command — is delivered ONLY to the @mentioned target bot's task frame.
    let row_bundle = params
        .context_bundle
        .as_ref()
        .map(crate::domain::context_bundle::strip_previews);

    let message_files = load_message_files(db, &file_ids).await?;
    let mut tx = db.begin().await.map_err(AppError::Db)?;
    if let Some(key) = &idempotency {
        if !key
            .claim(&mut tx)
            .await
            .map_err(|(_, message)| AppError::Conflict(message))?
        {
            drop(tx);
            let replayed = key
                .replay_claimed(db)
                .await
                .map_err(|(_, message)| AppError::Conflict(message))?;
            return serde_json::from_value(replayed)
                .map_err(|error| AppError::Internal(error.to_string()));
        }
    }
    let seq = channel_seq::allocate(&mut tx, params.channel_id)
        .await
        .map_err(AppError::Db)?;

    let thread_root_msg_id: Option<String> = sqlx::query_scalar!(
        "INSERT INTO messages
            (msg_id, channel_id, sender_type, sender_id, content, msg_type,
             is_partial, is_deleted, in_reply_to_msg_id, file_ids, created_at, channel_seq,
             context_bundle)
         VALUES ($1, $2, 'user', $3, $4, $5, FALSE, FALSE, $6, $7, $8, $9, $10)
         RETURNING thread_root_msg_id",
        msg_id.to_string(),
        params.channel_id.to_string(),
        params.user_id.to_string(),
        &params.content,
        msg_type,
        params.reply_to_msg_id.map(|id| id.to_string()),
        json!(file_ids.clone()),
        now,
        seq,
        row_bundle.clone(),
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(AppError::Db)?;

    mentions::insert_batch(&mut tx, msg_id, &mentions)
        .await
        .map_err(AppError::Db)?;

    // Freeze every accepted destination in the message's transaction. Session
    // promotion/default changes after commit cannot redirect recovered work.
    // Preparation never marks a session BUSY and performs no media/network I/O.
    let chain_id = if targets.is_empty() {
        None
    } else {
        Some(
            crate::domain::task_chains::start_chain_tx(&mut tx, params.channel_id, msg_id, msg_id)
                .await?
                .to_string(),
        )
    };
    let trigger_message = json!({
        "msg_id": msg_id,
        "user": params.user_id.to_string(),
        "sender_name": trigger_sender_name,
        "text": params.content,
        "timestamp": now.to_rfc3339(),
        "msg_type": msg_type,
        "in_reply_to_msg_id": params.reply_to_msg_id.map(|id| id.to_string()),
    });
    for (bot_id, context_bundle) in &targets {
        let session = match targeted_session {
            Some((expected_bot, session_id)) => {
                let (resolved_bot, provider_session_key) = sessions::resolve_channel_session_tx(
                    &mut tx,
                    &params.channel_id.to_string(),
                    session_id,
                )
                .await?;
                if resolved_bot != expected_bot || resolved_bot != *bot_id {
                    return Err(AppError::Conflict("target session changed".into()));
                }
                sessions::SessionHandle {
                    session_id,
                    provider_session_key,
                }
            }
            None => {
                match sessions::resolve_primary_session_tx(
                    &mut tx,
                    *bot_id,
                    &params.channel_id.to_string(),
                )
                .await?
                {
                    Some(session) => session,
                    None => {
                        let account_id =
                            resolve_provider_account_id_for_bot_tx(&mut tx, *bot_id).await?;
                        sessions::ensure_primary_session_workspace_tx(
                            &mut tx,
                            *bot_id,
                            &account_id,
                            &params.channel_id.to_string(),
                            None,
                            &[],
                        )
                        .await?;
                        // The authoritative binding may belong to a promoted
                        // session; never assume the deterministic ensure result
                        // is the destination, and never revive a closed session.
                        sessions::resolve_primary_session_tx(
                            &mut tx,
                            *bot_id,
                            &params.channel_id.to_string(),
                        )
                        .await?
                        .ok_or_else(|| {
                            AppError::Conflict("no live primary session is available".into())
                        })?
                    }
                }
            }
        };
        dispatch_intents::enqueue_human(
            &mut tx,
            HumanIntent {
                version: 1,
                author_id: params.user_id,
                params: DispatchParams {
                    trigger_msg_id: msg_id,
                    trigger_seq: seq,
                    bot_id: *bot_id,
                    channel_id: params.channel_id,
                    depth: 0,
                    provider_session_key: session.provider_session_key,
                    session_id: Some(session.session_id),
                    chain_id: chain_id.clone(),
                    context_bundle: context_bundle.clone(),
                },
                trigger_message: trigger_message.clone(),
                file_ids: file_ids.clone(),
            },
        )
        .await?;
    }

    let dto = MessageDto {
        v: MESSAGE_SCHEMA_VERSION,
        msg_id: msg_id.to_string(),
        channel_id: params.channel_id.to_string(),
        channel_seq: Some(seq),
        depth: 0,
        sender_type: "user".into(),
        sender_id: Some(params.user_id.to_string()),
        sender_name: sender_name.clone(),
        content: params.content.clone(),
        msg_type: msg_type.to_string(),
        is_partial: false,
        is_deleted: false,
        reply_to_msg_id: params.reply_to_msg_id.map(|id| id.to_string()),
        thread_root_msg_id,
        file_ids: file_ids.clone(),
        mentions: mentions
            .iter()
            .map(|mention| MessageMention {
                member_id: mention.member_id.to_string(),
                member_type: mention.member_type.as_str().to_string(),
                username: None,
                display_name: None,
            })
            .collect(),
        files: message_files,
        created_at: now,
        content_data: None,
        context_bundle: row_bundle.clone(),
        trace_count: Some(0),
        trace_has_failure: Some(false),
    };
    if let Some(key) = &idempotency {
        key.complete(
            &mut tx,
            &serde_json::to_value(&dto).map_err(|e| AppError::Internal(e.to_string()))?,
        )
        .await
        .map_err(|(_, message)| AppError::Internal(message))?;
    }
    tx.commit().await.map_err(AppError::Db)?;
    info!(message_id = %msg_id, channel_id = %params.channel_id, "message persisted");

    // ── 4. 再 fanout 终态帧（已落库，现在安全投递）────────────────────
    let wire = WireFrame::channel(
        params.channel_id,
        "message",
        json!({
            "v": MESSAGE_SCHEMA_VERSION,
            "msg_id": dto.msg_id,
            "channel_id": dto.channel_id,
            "channel_seq": dto.channel_seq,
            "sender_type": "user",
            "sender_id": params.user_id,
            "sender_name": sender_name,
            "content": dto.content,
            "msg_type": dto.msg_type,
            "is_partial": false,
            "is_deleted": false,
            "file_ids": &dto.file_ids,
            "mentions": &dto.mentions,
            "files": &dto.files,
            // Reply linkage rides the live frame too — without it the reply's
            // quote block only appears after a history refetch.
            "reply_to_msg_id": dto.reply_to_msg_id,
            "thread_root_msg_id": dto.thread_root_msg_id,
            "created_at": now,
            // Context chips render live (and on reload via the DTO) without a refetch.
            "context_bundle": dto.context_bundle,
        }),
    );
    fanout.broadcast_channel(params.channel_id, wire).await;
    info!(message_id = %msg_id, channel_id = %params.channel_id, "message fanout broadcast dispatched");

    info!(message_id = %msg_id, matched_bots = targets.len(), "committed bot dispatch intents");
    if let Err(error) =
        dispatch_intents::deliver_trigger(db, fanout, stream_registry, bot_locator, msg_id).await
    {
        tracing::warn!(%error, message_id = %msg_id, "committed dispatch intents retained for recovery");
    }

    info!(message_id = %msg_id, "create_message complete");
    Ok(dto)
}

pub async fn resolve_provider_account_id_for_bot(
    db: &PgPool,
    bot_id: Uuid,
) -> Result<String, AppError> {
    let binding_config = sqlx::query!(
        "SELECT binding_config FROM bot_accounts WHERE bot_id = $1",
        bot_id.to_string(),
    )
    .fetch_optional(db)
    .await
    .map_err(AppError::Db)?
    .and_then(|row| Some(row.binding_config.clone()))
    .ok_or(AppError::NotFound)?;

    let value = binding_config.ok_or(AppError::NotFound)?;
    resolve_provider_account_id_from_binding_config(&value).ok_or(AppError::NotFound)
}

pub(crate) async fn resolve_provider_account_id_for_bot_tx(
    tx: &mut Transaction<'_, Postgres>,
    bot_id: Uuid,
) -> Result<String, AppError> {
    let row = sqlx::query!(
        "SELECT binding_config FROM bot_accounts WHERE bot_id = $1",
        bot_id.to_string(),
    )
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(AppError::NotFound)?;
    // An account without an explicit provider account keeps the existing bot-id
    // default. Database failures and a removed bot never become a fallback task.
    Ok(row
        .binding_config
        .as_ref()
        .and_then(resolve_provider_account_id_from_binding_config)
        .unwrap_or_else(|| bot_id.to_string()))
}

fn resolve_provider_account_id_from_binding_config(
    binding_config: &serde_json::Value,
) -> Option<String> {
    fn trim_or_none(value: &serde_json::Value) -> Option<String> {
        let value = value.as_str()?.trim();
        if value.is_empty() {
            return None;
        }
        Some(value.to_string())
    }

    if let Some(acp) = binding_config
        .get("acp")
        .and_then(serde_json::Value::as_object)
    {
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
        if let Some(v) = binding_config.get(key).and_then(trim_or_none) {
            return Some(v);
        }
    }

    None
}

fn normalize_file_ids(file_ids: &[String]) -> Vec<String> {
    let mut normalized: Vec<String> = Vec::new();
    for raw in file_ids {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !normalized.iter().any(|existing| existing == trimmed) {
            normalized.push(trimmed.to_string());
        }
    }
    normalized
}

async fn validate_file_ids(
    db: &PgPool,
    uploader_id: Uuid,
    channel_id: Uuid,
    file_ids: &[String],
) -> Result<(), AppError> {
    for file_id in file_ids {
        let status = sqlx::query!(
            "SELECT status
             FROM file_records
             WHERE file_id = $1 AND channel_id = $2 AND uploader_id = $3",
            file_id,
            channel_id.to_string(),
            uploader_id.to_string(),
        )
        .fetch_optional(db)
        .await
        .map_err(AppError::Db)?
        .and_then(|row| Some(row.status.clone()));

        match status {
            Some(status) if status == "uploaded" => {}
            Some(status) => {
                return Err(AppError::BadRequest(format!(
                    "file_id {} is not ready (status={})",
                    file_id, status
                )));
            }
            None => {
                return Err(AppError::BadRequest(format!(
                    "invalid or inaccessible file_id {}",
                    file_id
                )));
            }
        }
    }

    Ok(())
}

// ── Bot 触发解析（mesh step 2）────────────────────────────────────────────────

/// 判断哪些 bot 应该响应这条消息（去中心化网格路由）。
///
/// 目标规则（DECENTRALIZED_MESH §2 + reply 路由）：
///   1. 从 `mentions`（写入时已解析）中取 type=bot 的成员。
///   2. 无 @bot 但回复的是某个 bot 的消息 → 触发该 bot（回复即指名道姓；
///      排在显式 @mention 之后、default_bot 之前）。
///   3. 否则回落 `channels.default_bot_id`（覆盖 workspace 级）。
///   4. 返回空 → 静默（消息仍记录）。
///
/// `mentions` 由 `create_message` 在消息事务内写入前扫描并验证，无额外查询。
pub(crate) async fn resolve_bot_triggers(
    db: &PgPool,
    channel_id: Uuid,
    mentions: &[crate::domain::mentions::Mention],
    reply_to_msg_id: Option<Uuid>,
) -> Result<Vec<Uuid>, AppError> {
    use crate::domain::mentions::MemberType;

    // 1. 从已解析的 mentions 取 bot
    let mentioned_bots: Vec<Uuid> = mentions
        .iter()
        .filter(|m| m.member_type == MemberType::Bot)
        .map(|m| m.member_id)
        .collect();

    if !mentioned_bots.is_empty() {
        return Ok(mentioned_bots);
    }

    // 2. 回复目标是本频道内某个 bot 的消息 → 触发该 bot。同频道校验防止跨频道
    //    注入；成员资格/可写角色由下游 filter_writable_bots 统一把关（与
    //    mention 路径一致）。此路径只在用户发消息时走到（bot 回帖不经过这里）。
    if let Some(reply_id) = reply_to_msg_id {
        let bot: Option<String> = sqlx::query_scalar!(
            "SELECT sender_id FROM messages
             WHERE msg_id = $1 AND channel_id = $2 AND sender_type = 'bot'
               AND is_deleted = FALSE",
            reply_id.to_string(),
            channel_id.to_string(),
        )
        .fetch_optional(db)
        .await?;
        if let Some(raw) = bot {
            let bot_id = Uuid::parse_str(&raw)
                .map_err(|_| AppError::Internal("invalid reply target bot_id".into()))?;
            return Ok(vec![bot_id]);
        }
    }

    // 3. 无 @bot、非回复 bot → 回落 channels.default_bot_id

    let row = sqlx::query!(
        "SELECT COALESCE(c.default_bot_id, w.default_bot_id) AS default_bot_id
         FROM channels c
         LEFT JOIN workspaces w ON w.workspace_id = c.workspace_id
         JOIN channel_memberships cm
           ON cm.channel_id = c.channel_id
          AND cm.member_type = 'bot'
          AND cm.member_id = COALESCE(c.default_bot_id, w.default_bot_id)
         WHERE c.channel_id = $1
           AND COALESCE(c.default_bot_id, w.default_bot_id) IS NOT NULL
         LIMIT 1",
        channel_id.to_string(),
    )
    .fetch_optional(db)
    .await?;
    match row.and_then(|row| row.default_bot_id) {
        Some(raw) => Ok(vec![Uuid::parse_str(&raw)
            .map_err(|_| AppError::Internal("invalid default bot_id".into()))?]),
        None => Ok(Vec::new()),
    }
}

/// 过滤出频道内角色可写（owner/admin/member）的 bot 成员。
/// A failed membership read must not admit an unauthorized durable intent or
/// turn a failed target lookup into a successful message without work.
pub(crate) async fn filter_writable_bots(
    db: &PgPool,
    channel_id: Uuid,
    bots: Vec<Uuid>,
) -> Result<Vec<Uuid>, sqlx::Error> {
    if bots.is_empty() {
        return Ok(bots);
    }
    let ids: Vec<String> = bots.iter().map(Uuid::to_string).collect();
    let writable = sqlx::query_scalar!(
        "SELECT member_id FROM channel_memberships
         WHERE channel_id = $1 AND member_type = 'bot'
           AND member_id = ANY($2)
           AND role IN ('owner', 'admin', 'member')",
        channel_id.to_string(),
        &ids,
    )
    .fetch_all(db)
    .await?;
    Ok(bots
        .into_iter()
        .filter(|id| writable.contains(&id.to_string()))
        .collect())
}

pub(crate) fn mention_parse_error_to_app(error: MentionParseError) -> AppError {
    match error {
        MentionParseError::Db(error) => AppError::Db(error),
        other => AppError::BadRequest(other.to_string()),
    }
}

// ── list_messages ─────────────────────────────────────────────────────────────

pub struct MessageListPage {
    pub messages: Vec<MessageDto>,
    pub has_more_before: bool,
    pub has_more_after: bool,
    pub has_more: bool,
    pub anchor_found: bool,
}

pub async fn list_messages(
    db: &PgPool,
    user_id: Uuid,
    channel_id: Uuid,
    before: Option<String>,
    after: Option<String>,
    limit: i64,
) -> Result<MessageListPage, AppError> {
    ensure_member(db, channel_id, user_id).await?;

    if before.is_some() && after.is_some() {
        return Err(AppError::BadRequest(
            "set either before or after, not both".into(),
        ));
    }

    list_channel_messages(db, &channel_id, before, after, limit).await
}

/// Permission-checked `channel_seq`-based catch-up: returns terminal messages
/// with `channel_seq > since_seq` ascending. This is the reconnect/refresh path
/// (the client tracks its last delivered `channel_seq` from the WS stream).
pub async fn list_messages_since_seq(
    db: &PgPool,
    user_id: Uuid,
    channel_id: Uuid,
    since_seq: i64,
    limit: i64,
) -> Result<MessageListPage, AppError> {
    ensure_member(db, channel_id, user_id).await?;
    list_channel_messages_since_seq(db, &channel_id, since_seq, limit).await
}

/// Permission-checked channel history search for HTTP clients.
pub async fn search_messages(
    db: &PgPool,
    user_id: Uuid,
    channel_id: Uuid,
    query: &str,
    before: Option<String>,
    limit: i64,
) -> Result<MessageListPage, AppError> {
    ensure_member(db, channel_id, user_id).await?;
    search_channel_messages(db, &channel_id, query, before, limit).await
}

/// Channel membership guard shared by the read paths. Any membership row
/// (user or bot) grants read access to the channel's history.
async fn ensure_member(db: &PgPool, channel_id: Uuid, user_id: Uuid) -> Result<(), AppError> {
    let is_member = sqlx::query!(
        "SELECT EXISTS(
            SELECT 1 AS present FROM channel_memberships
            WHERE channel_id = $1 AND member_id = $2
        ) AS ok",
        channel_id.to_string(),
        user_id.to_string(),
    )
    .fetch_one(db)
    .await
    .map_err(AppError::Db)?
    .ok
    .clone()
    .unwrap_or(false);

    if is_member {
        Ok(())
    } else {
        Err(AppError::Forbidden("not a channel member".into()))
    }
}

/// 无权限透传的消息列表读取（供 resource 层复用统一消息模型）。
///
/// 返回顺序为创建时间升序（调用者可直接返回）。
pub async fn list_channel_messages(
    db: &PgPool,
    channel_id: &Uuid,
    before: Option<String>,
    after: Option<String>,
    limit: i64,
) -> Result<MessageListPage, AppError> {
    let limit = limit.clamp(1, 200);
    let requested_limit = limit;

    let (rows, anchor_found, has_more_before, has_more_after, reverse_rows) = match (before, after)
    {
        (Some(before_id), None) => {
            let anchor = fetch_anchor(db, &before_id, channel_id).await?;

            if let Some((created_at, anchor_msg_id)) = anchor {
                let rows = sqlx::query_as!(
                    crate::infra::db::query_rows::MessageRow,
                    r###"SELECT m.msg_id AS id, m.depth, m.channel_id, m.sender_type, m.sender_id,
        m.channel_seq, u.display_name AS sender_name,
        m.content, m.msg_type, m.is_partial, m.is_deleted, m.file_ids,
        m.in_reply_to_msg_id AS reply_to_msg_id, m.thread_root_msg_id,
        m.created_at, m.content_data,
        m.context_bundle,
        trace_stats.trace_count,
        trace_stats.trace_has_failure
 FROM messages m
 LEFT JOIN users u ON m.sender_type = 'user' AND u.user_id = m.sender_id
 LEFT JOIN LATERAL (
    SELECT COUNT(*)::BIGINT AS trace_count,
           COALESCE(BOOL_OR(
             mt.phase IN ('prompt_failed', 'terminal_ack_failed')
             OR mt.status IN ('failed', 'error')
           ), FALSE) AS trace_has_failure
      FROM message_traces mt
     WHERE mt.msg_id = m.msg_id
 ) trace_stats ON TRUE
                     WHERE m.channel_id = $1
                       AND m.is_partial = FALSE
                       AND m.is_secret = FALSE
                       AND (
                           m.created_at < $2
                           OR (m.created_at = $2 AND m.msg_id < $3)
                       )
                     ORDER BY m.created_at DESC, m.msg_id DESC
                     LIMIT $4"###,
                    channel_id.to_string(),
                    created_at,
                    anchor_msg_id,
                    requested_limit + 1,
                )
                .fetch_all(db)
                .await
                .map_err(AppError::Db)?;
                (rows, true, true, false, true)
            } else {
                let rows = sqlx::query_as!(
                    crate::infra::db::query_rows::MessageRow,
                    r###"SELECT m.msg_id AS id, m.depth, m.channel_id, m.sender_type, m.sender_id,
        m.channel_seq, u.display_name AS sender_name,
        m.content, m.msg_type, m.is_partial, m.is_deleted, m.file_ids,
        m.in_reply_to_msg_id AS reply_to_msg_id, m.thread_root_msg_id,
        m.created_at, m.content_data,
        m.context_bundle,
        trace_stats.trace_count,
        trace_stats.trace_has_failure
 FROM messages m
 LEFT JOIN users u ON m.sender_type = 'user' AND u.user_id = m.sender_id
 LEFT JOIN LATERAL (
    SELECT COUNT(*)::BIGINT AS trace_count,
           COALESCE(BOOL_OR(
             mt.phase IN ('prompt_failed', 'terminal_ack_failed')
             OR mt.status IN ('failed', 'error')
           ), FALSE) AS trace_has_failure
      FROM message_traces mt
     WHERE mt.msg_id = m.msg_id
 ) trace_stats ON TRUE
                     WHERE m.channel_id = $1
                       AND m.is_partial = FALSE
                       AND m.is_secret = FALSE
                     ORDER BY m.created_at DESC, m.msg_id DESC
                     LIMIT $2"###,
                    channel_id.to_string(),
                    requested_limit + 1,
                )
                .fetch_all(db)
                .await
                .map_err(AppError::Db)?;
                (rows, false, true, false, true)
            }
        }
        (None, Some(after_id)) => {
            let anchor = fetch_anchor(db, &after_id, channel_id).await?;

            if let Some((created_at, anchor_msg_id)) = anchor {
                let rows = sqlx::query_as!(
                    crate::infra::db::query_rows::MessageRow,
                    r###"SELECT m.msg_id AS id, m.depth, m.channel_id, m.sender_type, m.sender_id,
        m.channel_seq, u.display_name AS sender_name,
        m.content, m.msg_type, m.is_partial, m.is_deleted, m.file_ids,
        m.in_reply_to_msg_id AS reply_to_msg_id, m.thread_root_msg_id,
        m.created_at, m.content_data,
        m.context_bundle,
        trace_stats.trace_count,
        trace_stats.trace_has_failure
 FROM messages m
 LEFT JOIN users u ON m.sender_type = 'user' AND u.user_id = m.sender_id
 LEFT JOIN LATERAL (
    SELECT COUNT(*)::BIGINT AS trace_count,
           COALESCE(BOOL_OR(
             mt.phase IN ('prompt_failed', 'terminal_ack_failed')
             OR mt.status IN ('failed', 'error')
           ), FALSE) AS trace_has_failure
      FROM message_traces mt
     WHERE mt.msg_id = m.msg_id
 ) trace_stats ON TRUE
                     WHERE m.channel_id = $1
                       AND m.is_partial = FALSE
                       AND m.is_secret = FALSE
                       AND (
                           m.created_at > $2
                           OR (m.created_at = $2 AND m.msg_id > $3)
                       )
                     ORDER BY m.created_at ASC, m.msg_id ASC
                     LIMIT $4"###,
                    channel_id.to_string(),
                    created_at,
                    anchor_msg_id,
                    requested_limit + 1,
                )
                .fetch_all(db)
                .await
                .map_err(AppError::Db)?;
                (rows, true, false, true, false)
            } else {
                (Vec::new(), false, false, false, false)
            }
        }
        (None, None) => {
            let rows = sqlx::query_as!(
                crate::infra::db::query_rows::MessageRow,
                r###"SELECT m.msg_id AS id, m.depth, m.channel_id, m.sender_type, m.sender_id,
        m.channel_seq, u.display_name AS sender_name,
        m.content, m.msg_type, m.is_partial, m.is_deleted, m.file_ids,
        m.in_reply_to_msg_id AS reply_to_msg_id, m.thread_root_msg_id,
        m.created_at, m.content_data,
        m.context_bundle,
        trace_stats.trace_count,
        trace_stats.trace_has_failure
 FROM messages m
 LEFT JOIN users u ON m.sender_type = 'user' AND u.user_id = m.sender_id
 LEFT JOIN LATERAL (
    SELECT COUNT(*)::BIGINT AS trace_count,
           COALESCE(BOOL_OR(
             mt.phase IN ('prompt_failed', 'terminal_ack_failed')
             OR mt.status IN ('failed', 'error')
           ), FALSE) AS trace_has_failure
      FROM message_traces mt
     WHERE mt.msg_id = m.msg_id
 ) trace_stats ON TRUE
                 WHERE m.channel_id = $1
                   AND m.is_partial = FALSE
                   AND m.is_secret = FALSE
                 ORDER BY m.created_at DESC, m.msg_id DESC
                 LIMIT $2"###,
                channel_id.to_string(),
                requested_limit + 1,
            )
            .fetch_all(db)
            .await
            .map_err(AppError::Db)?;
            (rows, true, true, false, true)
        }
        (Some(_), Some(_)) => unreachable!(),
    };

    let mut msgs = hydrate_message_rows(db, &rows).await?;
    let has_more = msgs.len() > requested_limit as usize;
    if has_more {
        msgs.truncate(requested_limit as usize);
    }

    if reverse_rows {
        msgs.reverse(); // DESC queries are normalized to ascending presentation order.
    }

    Ok(MessageListPage {
        messages: msgs,
        has_more_before,
        has_more_after,
        has_more,
        anchor_found,
    })
}

pub async fn list_channel_messages_since_seq(
    db: &PgPool,
    channel_id: &Uuid,
    since_seq: i64,
    limit: i64,
) -> Result<MessageListPage, AppError> {
    let limit = limit.clamp(1, 200);
    let rows = sqlx::query_as!(
        crate::infra::db::query_rows::MessageRow,
        r###"SELECT m.msg_id AS id, m.depth, m.channel_id, m.sender_type, m.sender_id,
        m.channel_seq, u.display_name AS sender_name,
        m.content, m.msg_type, m.is_partial, m.is_deleted, m.file_ids,
        m.in_reply_to_msg_id AS reply_to_msg_id, m.thread_root_msg_id,
        m.created_at, m.content_data,
        m.context_bundle,
        trace_stats.trace_count,
        trace_stats.trace_has_failure
 FROM messages m
 LEFT JOIN users u ON m.sender_type = 'user' AND u.user_id = m.sender_id
 LEFT JOIN LATERAL (
    SELECT COUNT(*)::BIGINT AS trace_count,
           COALESCE(BOOL_OR(
             mt.phase IN ('prompt_failed', 'terminal_ack_failed')
             OR mt.status IN ('failed', 'error')
           ), FALSE) AS trace_has_failure
      FROM message_traces mt
     WHERE mt.msg_id = m.msg_id
 ) trace_stats ON TRUE
         WHERE m.channel_id = $1
           AND m.is_partial = FALSE
           AND m.is_secret = FALSE
           AND m.channel_seq IS NOT NULL
           AND m.channel_seq > $2
         ORDER BY m.channel_seq ASC
         LIMIT $3"###,
        channel_id.to_string(),
        since_seq.max(0),
        limit + 1,
    )
    .fetch_all(db)
    .await
    .map_err(AppError::Db)?;

    let has_more = rows.len() > limit as usize;
    let rows = if has_more {
        &rows[..limit as usize]
    } else {
        &rows[..]
    };
    let messages = hydrate_message_rows(db, rows).await?;

    Ok(MessageListPage {
        messages,
        has_more_before: false,
        has_more_after: has_more,
        has_more,
        anchor_found: true,
    })
}

pub async fn list_channel_messages_by_seq(
    db: &PgPool,
    channel_id: &Uuid,
    min_seq: i64,
    max_seq: Option<i64>,
    limit: i64,
) -> Result<MessageListPage, AppError> {
    let limit = limit.clamp(1, 200);
    let rows = sqlx::query_as!(
        crate::infra::db::query_rows::MessageRow,
        r###"SELECT m.msg_id AS id, m.depth, m.channel_id, m.sender_type, m.sender_id,
        m.channel_seq, u.display_name AS sender_name,
        m.content, m.msg_type, m.is_partial, m.is_deleted, m.file_ids,
        m.in_reply_to_msg_id AS reply_to_msg_id, m.thread_root_msg_id,
        m.created_at, m.content_data,
        m.context_bundle,
        trace_stats.trace_count,
        trace_stats.trace_has_failure
 FROM messages m
 LEFT JOIN users u ON m.sender_type = 'user' AND u.user_id = m.sender_id
 LEFT JOIN LATERAL (
    SELECT COUNT(*)::BIGINT AS trace_count,
           COALESCE(BOOL_OR(
             mt.phase IN ('prompt_failed', 'terminal_ack_failed')
             OR mt.status IN ('failed', 'error')
           ), FALSE) AS trace_has_failure
      FROM message_traces mt
     WHERE mt.msg_id = m.msg_id
 ) trace_stats ON TRUE
         WHERE m.channel_id = $1
           AND m.is_partial = FALSE
           AND m.is_secret = FALSE
           AND m.channel_seq IS NOT NULL
           AND m.channel_seq >= $2
           AND ($3::bigint IS NULL OR m.channel_seq <= $3)
         ORDER BY m.channel_seq ASC
         LIMIT $4"###,
        channel_id.to_string(),
        min_seq.max(1),
        max_seq,
        limit + 1,
    )
    .fetch_all(db)
    .await
    .map_err(AppError::Db)?;

    let has_more = rows.len() > limit as usize;
    let rows = if has_more {
        &rows[..limit as usize]
    } else {
        &rows[..]
    };
    let messages = hydrate_message_rows(db, rows).await?;

    Ok(MessageListPage {
        messages,
        has_more_before: false,
        has_more_after: has_more,
        has_more,
        anchor_found: true,
    })
}

/// 无权限透传的消息内容搜索（供 resource 层复用统一消息模型）。
///
/// ILIKE 子串匹配（大小写不敏感；查询按字面处理，`%`/`_`/`\` 已转义），
/// 中英文皆可、无需额外索引或迁移。返回最新命中的一页（页内按时间升序，
/// 与其余 list_* 一致）；`before` 传上一页最旧命中的 msg_id 向更早翻页。
pub async fn search_channel_messages(
    db: &PgPool,
    channel_id: &Uuid,
    query: &str,
    before: Option<String>,
    limit: i64,
) -> Result<MessageListPage, AppError> {
    let limit = limit.clamp(1, 200);
    let pattern = format!("%{}%", escape_like_pattern(query));

    let (rows, anchor_found) = if let Some(before_id) = before {
        let anchor = fetch_anchor(db, &before_id, channel_id).await?;
        if let Some((created_at, anchor_msg_id)) = anchor {
            let rows = sqlx::query_as!(
                crate::infra::db::query_rows::MessageRow,
                r###"SELECT m.msg_id AS id, m.depth, m.channel_id, m.sender_type, m.sender_id,
        m.channel_seq, u.display_name AS sender_name,
        m.content, m.msg_type, m.is_partial, m.is_deleted, m.file_ids,
        m.in_reply_to_msg_id AS reply_to_msg_id, m.thread_root_msg_id,
        m.created_at, m.content_data,
        m.context_bundle,
        trace_stats.trace_count,
        trace_stats.trace_has_failure
 FROM messages m
 LEFT JOIN users u ON m.sender_type = 'user' AND u.user_id = m.sender_id
 LEFT JOIN LATERAL (
    SELECT COUNT(*)::BIGINT AS trace_count,
           COALESCE(BOOL_OR(
             mt.phase IN ('prompt_failed', 'terminal_ack_failed')
             OR mt.status IN ('failed', 'error')
           ), FALSE) AS trace_has_failure
      FROM message_traces mt
     WHERE mt.msg_id = m.msg_id
 ) trace_stats ON TRUE
                 WHERE m.channel_id = $1
                   AND m.is_partial = FALSE
                   AND m.is_secret = FALSE
                   AND m.content ILIKE $2
                   AND (
                       m.created_at < $3
                       OR (m.created_at = $3 AND m.msg_id < $4)
                   )
                 ORDER BY m.created_at DESC, m.msg_id DESC
                 LIMIT $5"###,
                channel_id.to_string(),
                &pattern,
                created_at,
                anchor_msg_id,
                limit + 1,
            )
            .fetch_all(db)
            .await
            .map_err(AppError::Db)?;
            (rows, true)
        } else {
            (Vec::new(), false)
        }
    } else {
        let rows = sqlx::query_as!(
            crate::infra::db::query_rows::MessageRow,
            r###"SELECT m.msg_id AS id, m.depth, m.channel_id, m.sender_type, m.sender_id,
        m.channel_seq, u.display_name AS sender_name,
        m.content, m.msg_type, m.is_partial, m.is_deleted, m.file_ids,
        m.in_reply_to_msg_id AS reply_to_msg_id, m.thread_root_msg_id,
        m.created_at, m.content_data,
        m.context_bundle,
        trace_stats.trace_count,
        trace_stats.trace_has_failure
 FROM messages m
 LEFT JOIN users u ON m.sender_type = 'user' AND u.user_id = m.sender_id
 LEFT JOIN LATERAL (
    SELECT COUNT(*)::BIGINT AS trace_count,
           COALESCE(BOOL_OR(
             mt.phase IN ('prompt_failed', 'terminal_ack_failed')
             OR mt.status IN ('failed', 'error')
           ), FALSE) AS trace_has_failure
      FROM message_traces mt
     WHERE mt.msg_id = m.msg_id
 ) trace_stats ON TRUE
             WHERE m.channel_id = $1
               AND m.is_partial = FALSE
               AND m.is_secret = FALSE
               AND m.content ILIKE $2
             ORDER BY m.created_at DESC, m.msg_id DESC
             LIMIT $3"###,
            channel_id.to_string(),
            &pattern,
            limit + 1,
        )
        .fetch_all(db)
        .await
        .map_err(AppError::Db)?;
        (rows, true)
    };

    let has_more = rows.len() > limit as usize;
    let rows = if has_more {
        &rows[..limit as usize]
    } else {
        &rows[..]
    };
    let mut messages = hydrate_message_rows(db, rows).await?;
    messages.reverse(); // 按时间升序返回

    Ok(MessageListPage {
        messages,
        has_more_before: has_more,
        has_more_after: false,
        has_more,
        anchor_found,
    })
}

/// LIKE/ILIKE 通配符转义：让用户查询按字面子串匹配（Postgres 默认转义符 `\`）。
pub fn escape_like_pattern(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// (created_at, msg_id) cursor anchor for keyset pagination.
#[derive(Debug, sqlx::FromRow)]
struct AnchorRow {
    created_at: chrono::DateTime<Utc>,
    msg_id: String,
}

/// Resolve a pagination anchor message (created_at + msg_id) within a channel.
/// Returns None if the anchor message does not exist or fails to decode.
async fn fetch_anchor(
    db: &PgPool,
    anchor_id: &str,
    channel_id: &Uuid,
) -> Result<Option<(chrono::DateTime<Utc>, String)>, AppError> {
    let anchor = sqlx::query_as!(
        AnchorRow,
        "SELECT msg_id, created_at
         FROM messages
         WHERE msg_id = $1 AND channel_id = $2 AND is_secret = FALSE
         LIMIT 1",
        anchor_id,
        channel_id.to_string(),
    )
    .fetch_optional(db)
    .await
    .map_err(AppError::Db)?
    .map(|row| (row.created_at, row.msg_id));
    Ok(anchor)
}

pub(crate) async fn hydrate_message_rows(
    db: &PgPool,
    rows: &[crate::infra::db::query_rows::MessageRow],
) -> Result<Vec<MessageDto>, AppError> {
    let mut msgs: Vec<MessageDto> = rows.iter().map(MessageDto::from_row).collect();
    if msgs.is_empty() {
        return Ok(msgs);
    }

    let message_ids: Vec<String> = msgs.iter().map(|message| message.msg_id.clone()).collect();
    let msg_mention_map = load_message_mentions(db, &message_ids).await?;
    let file_id_set = unique_file_ids_from_messages(&msgs);
    let file_ref_map = load_message_files_map(db, &file_id_set).await?;

    for message in &mut msgs {
        message.mentions = msg_mention_map
            .get(&message.msg_id)
            .cloned()
            .unwrap_or_default();
        message.files = normalize_message_file_refs(&message.file_ids, &file_ref_map);
    }

    Ok(msgs)
}

fn unique_file_ids_from_messages(messages: &[MessageDto]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for message in messages {
        for file_id in &message.file_ids {
            if seen.insert(file_id.clone()) {
                ids.push(file_id.clone());
            }
        }
    }
    ids
}

fn normalize_message_file_refs(
    file_ids: &[String],
    refs: &HashMap<String, MessageFileRef>,
) -> Vec<MessageFileRef> {
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();
    for file_id in file_ids {
        if !seen.insert(file_id.clone()) {
            continue;
        }
        if let Some(file_ref) = refs.get(file_id) {
            normalized.push(file_ref.clone());
        } else {
            normalized.push(MessageFileRef {
                file_id: file_id.clone(),
                original_filename: None,
                content_type: None,
                size_bytes: None,
                status: None,
                expires_at: None,
                preview_url: Some(format!("/api/v1/files/{}/preview", file_id)),
                download_url: Some(format!("/api/v1/files/{}/download", file_id)),
                summary: None,
            });
        }
    }
    normalized
}

pub(crate) async fn load_message_files(
    db: &PgPool,
    file_ids: &[String],
) -> Result<Vec<MessageFileRef>, AppError> {
    let file_refs = load_message_files_map(db, file_ids).await?;
    Ok(normalize_message_file_refs(file_ids, &file_refs))
}

async fn load_message_files_map(
    db: &PgPool,
    file_ids: &[String],
) -> Result<HashMap<String, MessageFileRef>, AppError> {
    if file_ids.is_empty() {
        return Ok(HashMap::new());
    }

    #[derive(Debug, sqlx::FromRow)]
    struct FileRow {
        file_id: String,
        original_filename: Option<String>,
        content_type: Option<String>,
        size_bytes: Option<i32>,
        status: Option<String>,
        expires_at: Option<chrono::DateTime<Utc>>,
        summary_3lines: Option<String>,
    }

    let rows = sqlx::query_as!(
        FileRow,
        "SELECT file_id, original_filename, content_type, size_bytes, status,
                expires_at, summary_3lines
         FROM file_records
         WHERE file_id = ANY($1)",
        file_ids,
    )
    .fetch_all(db)
    .await
    .map_err(AppError::Db)?;

    let mut refs = HashMap::new();
    for row in rows {
        let file_id = row.file_id;
        refs.insert(
            file_id.clone(),
            MessageFileRef {
                file_id: file_id.clone(),
                original_filename: row.original_filename,
                content_type: row.content_type,
                size_bytes: row.size_bytes.map(i64::from),
                status: row.status,
                expires_at: row.expires_at.map(|at| at.to_rfc3339()),
                preview_url: Some(format!("/api/v1/files/{}/preview", file_id)),
                download_url: Some(format!("/api/v1/files/{}/download", file_id)),
                summary: row.summary_3lines,
            },
        );
    }

    Ok(refs)
}

async fn load_message_mentions(
    db: &PgPool,
    msg_ids: &[String],
) -> Result<HashMap<String, Vec<MessageMention>>, AppError> {
    if msg_ids.is_empty() {
        return Ok(HashMap::new());
    }

    #[derive(Debug, sqlx::FromRow)]
    struct MentionRow {
        msg_id: String,
        member_type: String,
        member_id: String,
        username: Option<String>,
        display_name: Option<String>,
    }

    let rows = sqlx::query_as!(
        MentionRow,
        "SELECT mm.msg_id,
                mm.member_type,
                mm.member_id,
                COALESCE(u.username, ba.username) AS username,
                COALESCE(u.display_name, ba.display_name) AS display_name
         FROM message_mentions mm
         LEFT JOIN users u
                ON mm.member_type = 'user'
               AND u.user_id = mm.member_id
         LEFT JOIN bot_accounts ba
                ON mm.member_type = 'bot'
               AND ba.bot_id = mm.member_id
         WHERE mm.msg_id = ANY($1)",
        msg_ids,
    )
    .fetch_all(db)
    .await
    .map_err(AppError::Db)?;

    let mut by_msg = HashMap::new();
    for row in rows {
        let mention = MessageMention {
            member_id: row.member_id,
            member_type: row.member_type,
            username: row.username,
            display_name: row.display_name,
        };
        by_msg
            .entry(row.msg_id)
            .or_insert_with(Vec::new)
            .push(mention);
    }

    Ok(by_msg)
}

#[cfg(test)]
mod tests {
    use super::escape_like_pattern;

    #[tokio::test]
    async fn target_lookup_failures_do_not_become_empty_or_unfiltered_dispatches() {
        let db = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/closed_target_lookup_test")
            .unwrap();
        db.close().await;
        let channel_id = uuid::Uuid::new_v4();
        for reply in [None, Some(uuid::Uuid::new_v4())] {
            assert!(matches!(
                super::resolve_bot_triggers(&db, channel_id, &[], reply).await,
                Err(crate::errors::AppError::Db(sqlx::Error::PoolClosed))
            ));
        }
        assert!(matches!(
            super::filter_writable_bots(&db, channel_id, vec![uuid::Uuid::new_v4()]).await,
            Err(sqlx::Error::PoolClosed)
        ));
        assert!(matches!(
            crate::domain::message_policy::reauthorize_human_intent(
                &db,
                uuid::Uuid::new_v4(),
                channel_id,
                uuid::Uuid::new_v4(),
            )
            .await,
            Err(crate::domain::message_policy::HumanIntentPolicyError::Retryable(_))
        ));
    }

    /// 搜索 query 中的 LIKE 通配符必须按字面转义（默认转义符 `\`）。
    #[test]
    fn escape_like_pattern_escapes_wildcards() {
        assert_eq!(escape_like_pattern("plain"), "plain");
        assert_eq!(escape_like_pattern("100%"), "100\\%");
        assert_eq!(escape_like_pattern("a_b"), "a\\_b");
        assert_eq!(escape_like_pattern(r"c:\dir"), r"c:\\dir");
        assert_eq!(escape_like_pattern(r"\%_"), r"\\\%\_");
    }
}

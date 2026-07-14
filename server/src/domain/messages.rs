use std::collections::{HashMap, HashSet};
/// 消息领域逻辑。
///
/// 核心流程（写后投递原则）：
///   1. 验成员资格
///   2. INSERT message → PG
///   3. fanout::broadcast（终态帧，先落库再投递）
///   4. 解析 bot 触发条件
///   5. 对每个触发的 bot 调 dispatcher::dispatch
use std::sync::Arc;

use chrono::Utc;
use serde_json::json;
use sqlx::{PgPool, Row};
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::{
    domain::{
        channel_seq,
        mentions::{self, MentionParseError},
        sessions,
    },
    errors::AppError,
    gateway::{
        dispatcher::{self, DispatchParams},
        realtime::{fanout::Fanout, frame::WireFrame},
        registry::BotLocator,
        stream::StreamRegistry,
    },
    infra::db::models::{MessageDto, MessageFileRef, MessageMention, MESSAGE_SCHEMA_VERSION},
};

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
}

pub async fn create_message(
    db: &PgPool,
    fanout: &Arc<dyn Fanout>,
    stream_registry: &StreamRegistry,
    bot_locator: &Arc<dyn BotLocator>,
    params: CreateMessageParams,
) -> Result<MessageDto, AppError> {
    info!(user_id = %params.user_id, channel_id = %params.channel_id, "create_message start");

    let file_ids = normalize_file_ids(&params.file_ids);
    if !file_ids.is_empty() {
        validate_file_ids(db, params.user_id, params.channel_id, &file_ids).await?;
    }

    // ── 1. 验成员资格 ─────────────────────────────────────────────────────
    let is_member = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM channel_memberships
            WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'
        ) AS ok",
    )
    .bind(params.channel_id.to_string())
    .bind(params.user_id.to_string())
    .fetch_one(db)
    .await
    .map_err(AppError::Db)?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);

    if !is_member {
        info!(user_id = %params.user_id, channel_id = %params.channel_id, "create_message denied: user is not a member");
        return Err(AppError::Forbidden("not a channel member".into()));
    }

    // ── 2. 查发送者名字（用于 DTO）───────────────────────────────────────
    let sender_name: Option<String> =
        sqlx::query("SELECT display_name FROM users WHERE user_id = $1")
            .bind(params.user_id.to_string())
            .fetch_optional(db)
            .await
            .ok()
            .flatten()
            .and_then(|r| r.try_get("display_name").ok());

    // ── 3. 先落库（写后投递：INSERT 成功才广播）────────────────────────
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
    let msg_id = Uuid::new_v4();
    let msg_type = params.msg_type.as_deref().unwrap_or("text");
    let now = Utc::now();

    let mut tx = db.begin().await.map_err(AppError::Db)?;
    let seq = channel_seq::allocate(&mut tx, params.channel_id)
        .await
        .map_err(AppError::Db)?;

    sqlx::query(
        "INSERT INTO messages
            (msg_id, channel_id, sender_type, sender_id, content, msg_type,
             is_partial, is_deleted, in_reply_to_msg_id, file_ids, created_at, channel_seq)
         VALUES ($1, $2, 'user', $3, $4, $5, FALSE, FALSE, $6, $7, $8, $9)",
    )
    .bind(msg_id.to_string())
    .bind(params.channel_id.to_string())
    .bind(params.user_id.to_string())
    .bind(&params.content)
    .bind(msg_type)
    .bind(params.reply_to_msg_id.map(|id| id.to_string()))
    .bind(json!(file_ids.clone()))
    .bind(now)
    .bind(seq)
    .execute(&mut *tx)
    .await
    .map_err(AppError::Db)?;

    mentions::insert_batch(&mut tx, msg_id, &mentions)
        .await
        .map_err(AppError::Db)?;

    tx.commit().await.map_err(AppError::Db)?;
    info!(message_id = %msg_id, channel_id = %params.channel_id, "message persisted");

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
        reply_to_msg_id: params.reply_to_msg_id.map(|id| id.to_string()),
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
        files: load_message_files(&db, &file_ids).await?,
        created_at: now,
        content_data: None,
    };

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
            "file_ids": &dto.file_ids,
            "mentions": &dto.mentions,
            "files": &dto.files,
            // Reply linkage rides the live frame too — without it the reply's
            // quote block only appears after a history refetch.
            "reply_to_msg_id": dto.reply_to_msg_id,
            "created_at": now,
        }),
    );
    fanout.broadcast_channel(params.channel_id, wire).await;
    info!(message_id = %msg_id, channel_id = %params.channel_id, "message fanout broadcast dispatched");

    // ── 5. 解析 bot 触发，派发 task ───────────────────────────────────
    // A `session_id` targets a specific "other" session in this channel; it
    // overrides mention-based routing and determines which bot is prompted.
    let targeted_session = match params.session_id {
        Some(sid) => {
            let (bot, key) =
                sessions::resolve_channel_session(db, &params.channel_id.to_string(), sid)
                    .await
                    .map_err(|_| {
                        AppError::BadRequest("session not found in this channel".into())
                    })?;
            Some((bot, sid, key))
        }
        None => None,
    };
    let bots = match &targeted_session {
        Some((bot, _, _)) => vec![*bot],
        None => {
            resolve_bot_triggers(db, params.channel_id, &mentions, params.reply_to_msg_id).await
        }
    };
    // readonly 角色的 bot 不派发：它在 resource 层本就发不出消息，唤醒只会
    // 产生一个必然失败的回合。消息本身照常入库。
    let bots = filter_writable_bots(db, params.channel_id, bots).await;
    info!(message_id = %msg_id, matched_bots = bots.len(), "resolved bot triggers");

    // Root a bot@bot chain at this user message so the whole cascade it spawns is
    // cancelable as one unit (DECENTRALIZED_MESH §8) — only when it actually
    // triggers a bot (no dead rows for pure human chat).
    let chain_id: Option<String> = if bots.is_empty() {
        None
    } else {
        match crate::domain::task_chains::start_chain(db, params.channel_id, msg_id, msg_id).await {
            Ok(cid) => Some(cid.to_string()),
            Err(e) => {
                warn!(channel_id = %params.channel_id, err = %e, "start_chain failed; cascade will be un-cancelable");
                None
            }
        }
    };
    // Sender's channel role (for the INITIATE matrix); default 'member'.
    let sender_role: String = sqlx::query(
        "SELECT role FROM channel_memberships
         WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'",
    )
    .bind(params.channel_id.to_string())
    .bind(params.user_id.to_string())
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .and_then(|r| r.try_get::<Option<String>, _>("role").ok().flatten())
    .unwrap_or_else(|| "member".to_string());
    // Shared across all bots triggered by THIS message so identical trigger
    // attachments / pinned files are fetched from S3 once, not once per bot.
    let media_cache = dispatcher::MediaCache::default();
    for bot_id in bots {
        // Event-policy INITIATE gate (docs/arch/ACP_EVENT_TAXONOMY.md): may THIS user
        // trigger a `prompt` for THIS bot here? The message still posts to the channel;
        // we only skip waking the bot. Fail-open on a rules error (membership already
        // passed, and absence-of-policy = allowed).
        let may_prompt = crate::domain::acp_policy::allows(
            db,
            &bot_id.to_string(),
            &params.channel_id.to_string(),
            &params.user_id.to_string(),
            &sender_role,
            "session/prompt",
            crate::domain::bot_event_policy::Capability::Initiate,
        )
        .await
        .unwrap_or(true);
        if !may_prompt {
            info!(
                bot_id = %bot_id,
                user_id = %params.user_id,
                role = %sender_role,
                "INITIATE(prompt) denied by bot_event_policy; message posted, bot not triggered"
            );
            continue;
        }

        // Resolve the session to prompt. A targeted "other" session reuses its
        // own key (cheers:session:{id}); otherwise the channel PRIMARY session:
        // the `role='primary'` BINDING is authoritative (set_primary_session can
        // re-point it at a promoted "other" session, which keeps its own key), and
        // only when no live primary is bound is the scope-derived deterministic
        // key acquired (lazily creating the default primary on first message).
        let (provider_session_key, resolved_session_id) = match &targeted_session {
            Some((_, sid, key)) => {
                let _ = sessions::touch_session(db, *sid).await;
                (key.clone(), Some(*sid))
            }
            None => {
                match sessions::resolve_primary_session(db, bot_id, &params.channel_id.to_string())
                    .await
                    .ok()
                    .flatten()
                {
                    Some((sid, key)) => {
                        let _ = sessions::touch_session(db, sid).await;
                        (key, Some(sid))
                    }
                    None => {
                        let provider_session_key =
                            provider_session_key_for_bot_channel(params.channel_id, bot_id);
                        let provider_account_id = resolve_provider_account_id_for_bot(db, bot_id)
                            .await
                            .unwrap_or_else(|_| bot_id.to_string());
                        let session = sessions::acquire_scope_session(
                            db,
                            bot_id,
                            &provider_account_id,
                            &provider_session_key,
                            sessions::SESSION_SCOPE_CHANNEL,
                            &params.channel_id.to_string(),
                            None,
                            "primary",
                        )
                        .await;
                        if let Err(e) = &session {
                            warn!(
                                bot_id = %bot_id,
                                channel_id = %params.channel_id,
                                err = %e,
                                "session acquire failed, fallback to unbound task dispatch"
                            );
                        }
                        (provider_session_key, session.ok().map(|s| s.session_id))
                    }
                }
            }
        };

        let result = dispatcher::dispatch(
            db,
            fanout,
            stream_registry,
            bot_locator,
            DispatchParams {
                trigger_msg_id: msg_id,
                trigger_seq: seq,
                bot_id,
                channel_id: params.channel_id,
                depth: 0,
                provider_session_key,
                session_id: resolved_session_id,
                chain_id: chain_id.clone(),
            },
            &media_cache,
        )
        .await;

        if let dispatcher::DispatchResult::DbError(e) = result {
            tracing::warn!(bot_id = %bot_id, err = e, "dispatch failed");
        }
    }

    info!(message_id = %msg_id, "create_message complete");
    Ok(dto)
}

fn provider_session_key_for_bot_channel(channel_id: Uuid, bot_id: Uuid) -> String {
    format!("cheers:channel:{channel_id}:bot:{bot_id}")
}

pub async fn resolve_provider_account_id_for_bot(
    db: &PgPool,
    bot_id: Uuid,
) -> Result<String, AppError> {
    let binding_config = sqlx::query("SELECT binding_config FROM bot_accounts WHERE bot_id = $1")
        .bind(bot_id.to_string())
        .fetch_optional(db)
        .await
        .map_err(AppError::Db)?
        .and_then(|row| {
            row.try_get::<Option<serde_json::Value>, _>("binding_config")
                .ok()
        })
        .ok_or(AppError::NotFound)?;

    let value = binding_config.ok_or(AppError::NotFound)?;
    resolve_provider_account_id_from_binding_config(&value).ok_or(AppError::NotFound)
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
        let status = sqlx::query(
            "SELECT status
             FROM file_records
             WHERE file_id = $1 AND channel_id = $2 AND uploader_id = $3",
        )
        .bind(file_id)
        .bind(channel_id.to_string())
        .bind(uploader_id.to_string())
        .fetch_optional(db)
        .await
        .map_err(AppError::Db)?
        .and_then(|row| row.try_get::<Option<String>, _>("status").ok().flatten());

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
async fn resolve_bot_triggers(
    db: &PgPool,
    channel_id: Uuid,
    mentions: &[crate::domain::mentions::Mention],
    reply_to_msg_id: Option<Uuid>,
) -> Vec<Uuid> {
    use crate::domain::mentions::MemberType;

    // 1. 从已解析的 mentions 取 bot
    let mentioned_bots: Vec<Uuid> = mentions
        .iter()
        .filter(|m| m.member_type == MemberType::Bot)
        .map(|m| m.member_id)
        .collect();

    if !mentioned_bots.is_empty() {
        return mentioned_bots;
    }

    // 2. 回复目标是本频道内某个 bot 的消息 → 触发该 bot。同频道校验防止跨频道
    //    注入；成员资格/可写角色由下游 filter_writable_bots 统一把关（与
    //    mention 路径一致）。此路径只在用户发消息时走到（bot 回帖不经过这里）。
    if let Some(reply_id) = reply_to_msg_id {
        let bot: Option<String> = sqlx::query_scalar(
            "SELECT sender_id FROM messages
             WHERE msg_id = $1 AND channel_id = $2 AND sender_type = 'bot'
               AND is_deleted = FALSE",
        )
        .bind(reply_id.to_string())
        .bind(channel_id.to_string())
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
        if let Some(raw) = bot {
            if let Ok(bot_id) = Uuid::parse_str(&raw) {
                return vec![bot_id];
            }
        }
    }

    // 3. 无 @bot、非回复 bot → 回落 channels.default_bot_id
    use sqlx::Row;

    match sqlx::query(
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
    )
    .bind(channel_id.to_string())
    .fetch_optional(db)
    .await
    {
        Ok(Some(row)) => match row.try_get::<Option<String>, _>("default_bot_id") {
            Ok(Some(raw)) => Uuid::parse_str(&raw).into_iter().collect(),
            _ => vec![],
        },
        _ => vec![],
    }
}

/// 过滤出频道内角色可写（owner/admin/member）的 bot 成员。
/// readonly bot 不应被派发（见 resource 层 role_can_write）；查询失败时保守放行，
/// 与 INITIATE(prompt) gate 的 fail-open 语义一致（成员资格早已校验过）。
pub(crate) async fn filter_writable_bots(
    db: &PgPool,
    channel_id: Uuid,
    bots: Vec<Uuid>,
) -> Vec<Uuid> {
    if bots.is_empty() {
        return bots;
    }
    let ids: Vec<String> = bots.iter().map(Uuid::to_string).collect();
    let writable: Result<Vec<String>, _> = sqlx::query_scalar(
        "SELECT member_id FROM channel_memberships
         WHERE channel_id = $1 AND member_type = 'bot'
           AND member_id = ANY($2)
           AND role IN ('owner', 'admin', 'member')",
    )
    .bind(channel_id.to_string())
    .bind(&ids)
    .fetch_all(db)
    .await;
    match writable {
        Ok(writable) => bots
            .into_iter()
            .filter(|id| writable.contains(&id.to_string()))
            .collect(),
        Err(e) => {
            warn!(channel_id = %channel_id, err = %e, "filter_writable_bots query failed; fail-open");
            bots
        }
    }
}

fn mention_parse_error_to_app(error: MentionParseError) -> AppError {
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

    list_channel_messages(&db, &channel_id, before, after, limit).await
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

/// Channel membership guard shared by the read paths. Any membership row
/// (user or bot) grants read access to the channel's history.
async fn ensure_member(db: &PgPool, channel_id: Uuid, user_id: Uuid) -> Result<(), AppError> {
    let is_member = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM channel_memberships
            WHERE channel_id = $1 AND member_id = $2
        ) AS ok",
    )
    .bind(channel_id.to_string())
    .bind(user_id.to_string())
    .fetch_one(db)
    .await
    .map_err(AppError::Db)?
    .try_get::<bool, _>("ok")
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
/// Shared SELECT projection + FROM/JOIN for channel message listing.
/// Callers append their own WHERE / ORDER BY / LIMIT (with placeholders).
const MESSAGE_LIST_SELECT: &str = "SELECT m.msg_id AS id, m.channel_id, m.sender_type, m.sender_id,
        m.channel_seq, u.display_name AS sender_name,
        m.content, m.msg_type, m.is_partial, m.file_ids,
        m.in_reply_to_msg_id AS reply_to_msg_id, m.created_at, m.content_data
 FROM messages m
 LEFT JOIN users u ON m.sender_type = 'user' AND u.user_id = m.sender_id";

pub async fn list_channel_messages(
    db: &PgPool,
    channel_id: &Uuid,
    before: Option<String>,
    after: Option<String>,
    limit: i64,
) -> Result<MessageListPage, AppError> {
    let limit = limit.clamp(1, 200);
    let requested_limit = limit;

    let (rows, anchor_found, has_more_before, has_more_after) = match (before, after) {
        (Some(before_id), None) => {
            let anchor = fetch_anchor(db, &before_id, channel_id).await?;

            if let Some((created_at, anchor_msg_id)) = anchor {
                let rows = sqlx::query(&format!(
                    "{MESSAGE_LIST_SELECT}
                     WHERE m.channel_id = $1
                       AND m.is_partial = FALSE
                       AND (
                           m.created_at < $2
                           OR (m.created_at = $2 AND m.msg_id < $3)
                       )
                     ORDER BY m.created_at DESC, m.msg_id DESC
                     LIMIT $4"
                ))
                .bind(channel_id.to_string())
                .bind(created_at)
                .bind(anchor_msg_id)
                .bind(requested_limit + 1)
                .fetch_all(db)
                .await
                .map_err(AppError::Db)?;
                (rows, true, true, false)
            } else {
                let rows = sqlx::query(&format!(
                    "{MESSAGE_LIST_SELECT}
                     WHERE m.channel_id = $1
                       AND m.is_partial = FALSE
                     ORDER BY m.created_at DESC, m.msg_id DESC
                     LIMIT $2"
                ))
                .bind(channel_id.to_string())
                .bind(requested_limit + 1)
                .fetch_all(db)
                .await
                .map_err(AppError::Db)?;
                (rows, false, true, false)
            }
        }
        (None, Some(after_id)) => {
            let anchor = fetch_anchor(db, &after_id, channel_id).await?;

            if let Some((created_at, anchor_msg_id)) = anchor {
                let rows = sqlx::query(&format!(
                    "{MESSAGE_LIST_SELECT}
                     WHERE m.channel_id = $1
                       AND m.is_partial = FALSE
                       AND (
                           m.created_at > $2
                           OR (m.created_at = $2 AND m.msg_id > $3)
                       )
                     ORDER BY m.created_at DESC, m.msg_id DESC
                     LIMIT $4"
                ))
                .bind(channel_id.to_string())
                .bind(created_at)
                .bind(anchor_msg_id)
                .bind(requested_limit + 1)
                .fetch_all(db)
                .await
                .map_err(AppError::Db)?;
                (rows, true, false, true)
            } else {
                (Vec::new(), false, false, false)
            }
        }
        (None, None) => {
            let rows = sqlx::query(&format!(
                "{MESSAGE_LIST_SELECT}
                 WHERE m.channel_id = $1 AND m.is_partial = FALSE
                 ORDER BY m.created_at DESC, m.msg_id DESC
                 LIMIT $2"
            ))
            .bind(channel_id.to_string())
            .bind(requested_limit + 1)
            .fetch_all(db)
            .await
            .map_err(AppError::Db)?;
            (rows, true, true, false)
        }
        (Some(_), Some(_)) => unreachable!(),
    };

    let mut msgs = hydrate_message_rows(db, &rows).await?;
    let has_more = msgs.len() > requested_limit as usize;
    if has_more {
        msgs.truncate(requested_limit as usize);
    }

    msgs.reverse(); // 按时间升序返回

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
    let rows = sqlx::query(&format!(
        "{MESSAGE_LIST_SELECT}
         WHERE m.channel_id = $1
           AND m.is_partial = FALSE
           AND m.channel_seq IS NOT NULL
           AND m.channel_seq > $2
         ORDER BY m.channel_seq ASC
         LIMIT $3"
    ))
    .bind(channel_id.to_string())
    .bind(since_seq.max(0))
    .bind(limit + 1)
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
    let rows = sqlx::query(&format!(
        "{MESSAGE_LIST_SELECT}
         WHERE m.channel_id = $1
           AND m.is_partial = FALSE
           AND m.channel_seq IS NOT NULL
           AND m.channel_seq >= $2
           AND ($3::bigint IS NULL OR m.channel_seq <= $3)
         ORDER BY m.channel_seq ASC
         LIMIT $4"
    ))
    .bind(channel_id.to_string())
    .bind(min_seq.max(1))
    .bind(max_seq)
    .bind(limit + 1)
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
            let rows = sqlx::query(&format!(
                "{MESSAGE_LIST_SELECT}
                 WHERE m.channel_id = $1
                   AND m.is_partial = FALSE
                   AND m.content ILIKE $2
                   AND (
                       m.created_at < $3
                       OR (m.created_at = $3 AND m.msg_id < $4)
                   )
                 ORDER BY m.created_at DESC, m.msg_id DESC
                 LIMIT $5"
            ))
            .bind(channel_id.to_string())
            .bind(&pattern)
            .bind(created_at)
            .bind(anchor_msg_id)
            .bind(limit + 1)
            .fetch_all(db)
            .await
            .map_err(AppError::Db)?;
            (rows, true)
        } else {
            (Vec::new(), false)
        }
    } else {
        let rows = sqlx::query(&format!(
            "{MESSAGE_LIST_SELECT}
             WHERE m.channel_id = $1
               AND m.is_partial = FALSE
               AND m.content ILIKE $2
             ORDER BY m.created_at DESC, m.msg_id DESC
             LIMIT $3"
        ))
        .bind(channel_id.to_string())
        .bind(&pattern)
        .bind(limit + 1)
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
    let anchor = sqlx::query_as::<_, AnchorRow>(
        "SELECT msg_id, created_at
         FROM messages
         WHERE msg_id = $1 AND channel_id = $2
         LIMIT 1",
    )
    .bind(anchor_id)
    .bind(channel_id.to_string())
    .fetch_optional(db)
    .await
    .map_err(AppError::Db)?
    .map(|row| (row.created_at, row.msg_id));
    Ok(anchor)
}

async fn hydrate_message_rows(
    db: &PgPool,
    rows: &[sqlx::postgres::PgRow],
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

    let rows = sqlx::query_as::<_, FileRow>(
        "SELECT file_id, original_filename, content_type, size_bytes, status,
                expires_at, summary_3lines
         FROM file_records
         WHERE file_id = ANY($1)",
    )
    .bind(file_ids)
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

    let rows = sqlx::query_as::<_, MentionRow>(
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
    )
    .bind(msg_ids)
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

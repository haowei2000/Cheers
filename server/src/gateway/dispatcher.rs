/// 任务派发器。
///
/// 职责：
/// - 幂等检查（占位是否已存在）
/// - 创建 is_partial=true 占位消息
/// - 注册到 StreamRegistry
/// - 通过 BotLocator 发 control WS task 帧
use std::sync::Arc;

use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{
    registry::BotLocator,
    stream::{StreamEntry, StreamRegistry},
};
use crate::domain::{channel_seq, sessions};
use crate::gateway::realtime::{fanout::Fanout, frame::WireFrame};
use crate::infra::db::models::MESSAGE_SCHEMA_VERSION;

/// 派发参数。
pub struct DispatchParams {
    pub trigger_msg_id: Uuid,
    pub trigger_seq: i64,
    pub bot_id: Uuid,
    pub channel_id: Uuid,
    pub depth: i32,
    pub provider_session_key: String,
    pub session_id: Option<Uuid>,
    /// The bot@bot chain this hop belongs to (DECENTRALIZED_MESH §8). Stamped onto
    /// the placeholder so the whole cascade is cancelable as one unit and the
    /// dispatch gate can block hops of a cancelled chain. `None` for un-tracked
    /// dispatch (a targeted session, or a message that triggers no bot).
    pub chain_id: Option<String>,
}

/// 派发结果。
pub enum DispatchResult {
    /// 成功派发，返回占位 msg_id。
    Dispatched { placeholder_msg_id: Uuid },
    /// 幂等：该 (trigger_msg_id, bot_id) 已有占位且仍在处理，跳过。
    AlreadyInProgress,
    /// bot 不在线。
    BotOffline,
    /// 数据库错误。
    DbError(String),
}

/// Per-trigger memo for the S3-backed context that every bot triggered by the SAME
/// message would otherwise re-fetch independently: attachment bytes (an image can be
/// up to 8 MB, GET + base64 per bot), audio transcripts, and the channel's pinned
/// prompt blocks. Callers create one instance before their per-bot dispatch loop and
/// pass `&cache` into each `dispatch`, so each object is fetched at most once per
/// trigger. Per-bot inlining decisions (budget, audio capability) are unchanged — only
/// the byte fetch is shared. `None`/miss is memoized too (best-effort: don't re-hit S3).
#[derive(Default)]
pub struct MediaCache {
    b64: tokio::sync::Mutex<std::collections::HashMap<String, Option<String>>>,
    transcript: tokio::sync::Mutex<std::collections::HashMap<String, Option<String>>>,
    pinned: tokio::sync::Mutex<std::collections::HashMap<Uuid, Vec<String>>>,
}

impl MediaCache {
    /// Cached [`load_pinned_context`] keyed by channel (pinned blocks are per-channel,
    /// bot-independent).
    async fn pinned_context(&self, db: &PgPool, channel_id: Uuid) -> Vec<String> {
        if let Some(hit) = self.pinned.lock().await.get(&channel_id).cloned() {
            return hit;
        }
        let blocks = load_pinned_context(db, channel_id).await;
        self.pinned.lock().await.insert(channel_id, blocks.clone());
        blocks
    }
}

pub async fn dispatch(
    db: &PgPool,
    fanout: &Arc<dyn Fanout>,
    registry: &StreamRegistry,
    bot_locator: &Arc<dyn BotLocator>,
    params: DispatchParams,
    media_cache: &MediaCache,
) -> DispatchResult {
    // ── 原子创建占位（先落库）────────────────────────────────────────────────
    // 占位 id 由 (trigger_msg_id, bot_id) 确定性派生（I4）：同一输入永远同一 UUID。
    // R5：不再用前置 SELECT 判幂等（与 INSERT 非原子，并发双触发会两边都通过，
    // 导致 task 帧派发两次、bot 重复跑同一任务）。改由 `INSERT … ON CONFLICT
    // DO NOTHING` 的 rows_affected 单点定胜负——只有真正插入占位的调用继续派发。
    let placeholder_id = derive_placeholder_id(params.trigger_msg_id, params.bot_id);
    let task_id = Uuid::new_v4();

    match create_placeholder(
        db,
        placeholder_id,
        params.channel_id,
        params.bot_id,
        params.depth,
        params.chain_id.as_deref(),
    )
    .await
    {
        Ok(true) => {}                                         // 胜者：本次插入占位，继续派发
        Ok(false) => return DispatchResult::AlreadyInProgress, // 占位已存在（败者 / 重投）
        Err(e) => return DispatchResult::DbError(e),
    }

    // ── 注册 StreamEntry ─────────────────────────────────────────────────────
    registry.register(StreamEntry {
        msg_id: placeholder_id,
        bot_id: params.bot_id,
        channel_id: params.channel_id,
        task_id,
        session_id: params.session_id,
        finalized: false,
        last_touched_ms: Default::default(),
    });

    // ── fan-out 占位气泡给浏览器（终态帧，先落库再投递）─────────────────────
    let bubble = WireFrame::channel(
        params.channel_id,
        "message",
        json!({
            "v": MESSAGE_SCHEMA_VERSION,
            "msg_id": placeholder_id,
            "channel_id": params.channel_id,
            "channel_seq": null,
            "sender_id": params.bot_id,
            "sender_type": "bot",
            "content": "",
            "msg_type": "text",
            "is_partial": true,
            "reply_to_msg_id": null,
            "file_ids": [],
            "mentions": [],
            "files": [],
        }),
    );
    fanout.broadcast_channel(params.channel_id, bubble).await;
    tracing::debug!(
        bot_id = %params.bot_id,
        channel_id = %params.channel_id,
        placeholder_msg_id = %placeholder_id,
        "placeholder created and empty bubble fanned out"
    );

    // ── 通过 control WS 派发 task 帧给 bot ───────────────────────────────────
    let mut task_context = load_task_context(db, params.trigger_msg_id, params.bot_id, media_cache)
        .await
        .unwrap_or_else(|| TaskContext::fallback(params.trigger_msg_id));
    task_context.pinned = media_cache.pinned_context(db, params.channel_id).await;
    // Per-session ACP root set (cwd + additionalDirectories) stored on the session
    // row; absent → the connector falls back to its default_cwd.
    let workspace = load_session_workspace(db, &params.provider_session_key).await;
    let task_frame = build_task_frame(
        task_id,
        params.channel_id,
        params.trigger_msg_id,
        params.trigger_seq,
        params.depth,
        placeholder_id,
        &params.provider_session_key,
        params.session_id,
        task_context,
        workspace,
    );

    let delivered = bot_locator.dispatch_task(params.bot_id, task_frame).await;

    if !delivered {
        // bot 不在线：清理占位（或标记为失败，让前端看到错误提示）
        if let Ok(Some(failed)) = mark_placeholder_failed(db, placeholder_id).await {
            let done = offline_done_frame(
                failed.channel_id,
                failed.channel_seq,
                placeholder_id,
                params.bot_id,
            );
            fanout.broadcast_channel(failed.channel_id, done).await;
        }
        registry.remove(placeholder_id);
        if let Some(session_id) = params.session_id {
            let _ = sessions::finalize_session(db, session_id).await;
        }
        return DispatchResult::BotOffline;
    }

    // The bot is now working on this turn. The matching "idle" signal is the
    // turn's `message_done` (or the offline/failed done-frame above) — clients
    // (Fleet view, chat) pair the two; no separate end frame is needed.
    let processing = WireFrame::channel(
        params.channel_id,
        "bot_processing",
        json!({ "bot_id": params.bot_id, "channel_id": params.channel_id }),
    );
    fanout.broadcast_channel(params.channel_id, processing).await;

    tracing::info!(
        bot_id = %params.bot_id,
        channel_id = %params.channel_id,
        trigger_msg_id = %params.trigger_msg_id,
        placeholder_msg_id = %placeholder_id,
        task_id = %task_id,
        "task dispatched to bot"
    );
    DispatchResult::Dispatched {
        placeholder_msg_id: placeholder_id,
    }
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/// R3：确定性派生占位 id。
/// UUID v5（SHA-1 namespace + "trigger_id:bot_id"）保证幂等。
fn derive_placeholder_id(trigger_msg_id: Uuid, bot_id: Uuid) -> Uuid {
    use uuid::Uuid;
    // 用 UUID v5 的 DNS namespace 作为固定 namespace
    let namespace = Uuid::NAMESPACE_DNS;
    let name = format!("{trigger_msg_id}:{bot_id}");
    Uuid::new_v5(&namespace, name.as_bytes())
}

/// 原子创建占位。返回 `true` 表示本次 INSERT 胜出（rows_affected == 1）；
/// `false` 表示占位已存在（并发双触发的败者，或同一触发的重投）——调用方据此
/// 放弃派发，避免 bot 重复跑同一任务（R5）。
async fn create_placeholder(
    db: &PgPool,
    placeholder_id: Uuid,
    channel_id: Uuid,
    bot_id: Uuid,
    depth: i32,
    chain_id: Option<&str>,
) -> Result<bool, String> {
    let result = sqlx::query(
        "INSERT INTO messages
            (msg_id, channel_id, sender_type, sender_id, content, is_partial, depth, chain_id)
         VALUES ($1, $2, 'bot', $3, '', TRUE, $4, $5)
         ON CONFLICT (msg_id) DO NOTHING",
    )
    .bind(placeholder_id.to_string())
    .bind(channel_id.to_string())
    .bind(bot_id.to_string())
    .bind(depth)
    .bind(chain_id)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;

    Ok(result.rows_affected() == 1)
}

pub(crate) struct FailedPlaceholder {
    pub(crate) channel_id: Uuid,
    pub(crate) channel_seq: i64,
}

/// 构造 bot-offline 的 `message_done` 终态帧（占位被 finalize 为 "[bot offline]"）。
/// 派发期 bot 不在线与孤儿回收器共用此帧形状。
pub(crate) fn offline_done_frame(
    channel_id: Uuid,
    channel_seq: i64,
    msg_id: Uuid,
    bot_id: Uuid,
) -> WireFrame {
    WireFrame::channel(
        channel_id,
        "message_done",
        json!({
            "v": MESSAGE_SCHEMA_VERSION,
            "msg_id": msg_id,
            "channel_id": channel_id,
            "channel_seq": channel_seq,
            "sender_id": bot_id,
            "sender_type": "bot",
            "content": "[bot offline]",
            "msg_type": "text",
            "is_partial": false,
            "reply_to_msg_id": null,
            "file_ids": [],
            "mentions": [],
            "files": [],
        }),
    )
}

struct TaskContext {
    trigger_message: Value,
    attachments: Vec<Value>,
    /// Pinned convention/prompt blocks (formatted) injected into the prompt every
    /// request — the channel's semantic layer (e.g. a pinned prompt template).
    pinned: Vec<String>,
}

impl TaskContext {
    fn fallback(msg_id: Uuid) -> Self {
        Self {
            trigger_message: json!({ "msg_id": msg_id }),
            attachments: Vec::new(),
            pinned: Vec::new(),
        }
    }
}

async fn load_task_context(
    db: &PgPool,
    msg_id: Uuid,
    bot_id: Uuid,
    media_cache: &MediaCache,
) -> Option<TaskContext> {
    #[derive(Debug, sqlx::FromRow)]
    struct TaskRow {
        sender_id: Option<String>,
        content: Option<String>,
        created_at: Option<chrono::DateTime<chrono::Utc>>,
        msg_type: Option<String>,
        in_reply_to_msg_id: Option<String>,
        file_ids: Option<Value>,
        sender_name: Option<String>,
    }

    let row = sqlx::query_as::<_, TaskRow>(
        "SELECT
            m.msg_id,
            m.sender_id,
            m.sender_type,
            m.content,
            m.created_at,
            m.msg_type,
            m.in_reply_to_msg_id,
            m.file_ids,
            COALESCE(NULLIF(u.display_name, ''), u.username, NULLIF(b.display_name, ''), b.username) AS sender_name
         FROM messages m
         LEFT JOIN users u ON m.sender_type = 'user' AND u.user_id = m.sender_id
         LEFT JOIN bot_accounts b ON m.sender_type = 'bot' AND b.bot_id = m.sender_id
         WHERE m.msg_id = $1",
    )
    .bind(msg_id.to_string())
    .fetch_optional(db)
    .await
    .ok()??;

    let file_ids = row
        .file_ids
        .and_then(|value| {
            value.as_array().map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>()
            })
        })
        .unwrap_or_default();
    let attachments = load_attachments(db, &file_ids, bot_id, media_cache).await;
    let timestamp = row.created_at.map(|dt| dt.to_rfc3339());

    Some(TaskContext {
        trigger_message: json!({
            "msg_id": msg_id,
            "user": row.sender_id.unwrap_or_default(),
            "sender_name": row.sender_name,
            "text": row.content.unwrap_or_default(),
            "timestamp": timestamp,
            "msg_type": row.msg_type.unwrap_or_else(|| "text".to_string()),
            "in_reply_to_msg_id": row.in_reply_to_msg_id,
        }),
        attachments,
        pinned: Vec::new(),
    })
}

/// Largest single image inlined (raw bytes) into a task frame as `image_b64` — same ceiling
/// as the agent bridge's `MAX_DELIVER_BYTES` so both delivery paths agree on "too big".
const MAX_INLINE_IMAGE_BYTES: i64 = 8 * 1024 * 1024;
/// Shared raw-byte budget across ALL attachments of one task frame. The frame travels as a
/// single WS message and the connector reads it with tungstenite defaults (16 MiB frame cap);
/// 8 MB raw ≈ 10.7 MB base64 keeps the whole frame safely under that even with prompt text.
const MAX_INLINE_TOTAL_BYTES: i64 = 8 * 1024 * 1024;

/// Longest transcript text inlined into an attachment's `summary`. Transcripts
/// are prompt text, not bulk bytes — cap them so one long recording can't
/// crowd out the rest of the prompt.
const MAX_INLINE_TRANSCRIPT_CHARS: usize = 8_000;

#[derive(Debug, sqlx::FromRow)]
struct AttachmentRow {
    file_id: String,
    original_filename: Option<String>,
    content_type: Option<String>,
    size_bytes: Option<i32>,
    object_key: Option<String>,
    storage_bucket: Option<String>,
    status: String,
    expired: bool,
    /// Transcript object key (`transcripts/{file_id}.txt`) for audio files the
    /// transcription worker has processed; NULL otherwise.
    md_path: Option<String>,
}

/// Hydrate a message's `file_ids` into task-frame attachments the ACP connector can consume:
/// `{ file_id, filename, content_type, size_bytes, is_image }`, plus inline base64 bytes
/// (`image_b64`) for images small enough to ride the control WS — that is what lets the
/// connector emit native ACP image content blocks instead of a filename summary line.
/// Everything here is best-effort: any DB/S3 failure degrades to metadata-only (or the bare
/// `file_id`), never blocks the dispatch. Non-inlined files stay reachable via the MCP inbox.
async fn load_attachments(
    db: &PgPool,
    file_ids: &[String],
    bot_id: Uuid,
    media_cache: &MediaCache,
) -> Vec<Value> {
    if file_ids.is_empty() {
        return Vec::new();
    }
    // Whether this bot's agent accepts native ACP audio blocks (persisted from
    // the connector's ready frame). NULL/missing = false: don't spend frame
    // budget on bytes the connector would degrade to a summary line anyway.
    let bot_accepts_audio = sqlx::query_scalar::<_, Option<bool>>(
        "SELECT (binding_config->'connector_control'->'capabilities'->>'audio')::boolean
         FROM bot_accounts WHERE bot_id = $1",
    )
    .bind(bot_id.to_string())
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .flatten()
    .unwrap_or(false);
    let rows = sqlx::query_as::<_, AttachmentRow>(
        "SELECT file_id, original_filename, content_type, size_bytes, object_key,
                storage_bucket, status, md_path,
                COALESCE(expires_at < NOW(), FALSE) AS expired
         FROM file_records
         WHERE file_id = ANY($1)",
    )
    .bind(file_ids)
    .fetch_all(db)
    .await
    .unwrap_or_else(|e| {
        tracing::warn!(err = %e, "attachment metadata load failed; sending bare file_ids");
        Vec::new()
    });

    let mut inline_budget = MAX_INLINE_TOTAL_BYTES;
    let mut out = Vec::with_capacity(file_ids.len());
    // Preserve message order (rows come back in arbitrary ANY($1) order).
    for file_id in file_ids {
        let Some(row) = rows.iter().find(|r| &r.file_id == file_id) else {
            out.push(json!({ "file_id": file_id }));
            continue;
        };
        let is_image = row
            .content_type
            .as_deref()
            .is_some_and(|ct| ct.starts_with("image/"));
        let is_audio = row
            .content_type
            .as_deref()
            .is_some_and(|ct| ct.starts_with("audio/"));
        let mut attachment = json!({
            "file_id": row.file_id,
            "filename": row.original_filename,
            "content_type": row.content_type,
            "size_bytes": row.size_bytes,
            "is_image": is_image,
            "is_audio": is_audio,
        });
        if is_image && should_inline_media(row, inline_budget) {
            if let Some(data_b64) = fetch_media_b64(row, media_cache).await {
                inline_budget -= i64::from(row.size_bytes.unwrap_or(0));
                attachment["image_b64"] = json!(data_b64);
            }
        }
        // Audio delivery ladder: transcript-first (cheap prompt tokens every
        // agent can read); else, for agents that advertised audio support,
        // inline the bytes as base64 so the connector can emit a native ACP
        // audio block; else the metadata line above is all the agent gets.
        if is_audio {
            let transcript = if row.md_path.is_some() {
                fetch_transcript(row, media_cache).await
            } else {
                None
            };
            match transcript {
                Some(text) => {
                    attachment["summary"] = json!(format!("transcript: {text}"));
                }
                None if bot_accepts_audio && should_inline_media(row, inline_budget) => {
                    // Same eligibility gate as images (uploaded, unexpired,
                    // size within the shared frame budget).
                    if let Some(data_b64) = fetch_media_b64(row, media_cache).await {
                        inline_budget -= i64::from(row.size_bytes.unwrap_or(0));
                        attachment["audio_b64"] = json!(data_b64);
                    }
                }
                None => {}
            }
        }
        out.push(attachment);
    }
    out
}

/// Whether an image attachment's bytes qualify for inlining: readable object (`uploaded`,
/// not expired, has an object_key), a known size within the per-image cap, and room left in
/// the frame's shared budget. `staged` files have no bytes in S3 yet; unknown sizes are
/// skipped rather than risking an oversized frame.
fn should_inline_media(row: &AttachmentRow, inline_budget: i64) -> bool {
    let Some(size) = row.size_bytes else {
        return false;
    };
    row.status == "uploaded"
        && !row.expired
        && row.object_key.is_some()
        && i64::from(size) <= MAX_INLINE_IMAGE_BYTES
        && i64::from(size) <= inline_budget
}

/// Fetch a stored audio transcript (`md_path` object), capped for prompt use.
/// Best-effort like everything here: a miss just means the attachment goes out
/// without a summary and the agent can still pull bytes via the MCP inbox.
async fn fetch_transcript(row: &AttachmentRow, cache: &MediaCache) -> Option<String> {
    let (client, default_bucket) = crate::resource::files::s3_handle()?;
    let bucket = row.storage_bucket.as_deref().unwrap_or(default_bucket);
    let transcript_key = row.md_path.as_deref()?;
    let cache_key = format!("{bucket}/{transcript_key}");
    // Memo: bots sharing this trigger read the identical transcript object.
    if let Some(hit) = cache.transcript.lock().await.get(&cache_key).cloned() {
        return hit;
    }
    let result = match crate::infra::s3::get_object(client, bucket, transcript_key).await {
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes);
            let text = text.trim();
            if text.is_empty() {
                None
            } else if text.chars().count() > MAX_INLINE_TRANSCRIPT_CHARS {
                let cut: String = text.chars().take(MAX_INLINE_TRANSCRIPT_CHARS).collect();
                Some(format!("{cut}… [transcript truncated]"))
            } else {
                Some(text.to_string())
            }
        }
        Err(e) => {
            tracing::warn!(file_id = %row.file_id, err = %e, "attachment transcript fetch failed");
            None
        }
    };
    cache
        .transcript
        .lock()
        .await
        .insert(cache_key, result.clone());
    result
}

async fn fetch_media_b64(row: &AttachmentRow, cache: &MediaCache) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let (client, default_bucket) = crate::resource::files::s3_handle()?;
    let bucket = row.storage_bucket.as_deref().unwrap_or(default_bucket);
    let object_key = row.object_key.as_deref()?;
    let cache_key = format!("{bucket}/{object_key}");
    // Memo: an 8 MB image @mentioned to N bots is fetched + base64-encoded once, not N times.
    if let Some(hit) = cache.b64.lock().await.get(&cache_key).cloned() {
        return hit;
    }
    let result = match crate::infra::s3::get_object(client, bucket, object_key).await {
        Ok(bytes) => Some(STANDARD.encode(&bytes)),
        Err(e) => {
            tracing::warn!(file_id = %row.file_id, err = %e, "attachment image fetch failed; sending metadata only");
            None
        }
    };
    cache.b64.lock().await.insert(cache_key, result.clone());
    result
}

/// Read the channel's pinned convention files (paths listed in `.workbench.json`)
/// and format each into a prompt block. These are injected into the agent prompt on
/// EVERY request (the semantic layer) — a controlled push, not auto-memory.
pub async fn load_pinned_context(db: &PgPool, channel_id: Uuid) -> Vec<String> {
    let cfg = sqlx::query_scalar::<_, String>(
        "SELECT content FROM context_files WHERE channel_id = $1 AND path = '.workbench.json'",
    )
    .bind(channel_id.to_string())
    .fetch_optional(db)
    .await
    .ok()
    .flatten();
    let Some(cfg) = cfg else {
        return Vec::new();
    };
    let paths: Vec<String> = serde_json::from_str::<Value>(&cfg)
        .ok()
        .and_then(|v| {
            v.get("pinned").and_then(Value::as_array).map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
        })
        .unwrap_or_default();
    let mut out = Vec::new();
    for path in paths {
        if let Ok(Some(content)) = sqlx::query_scalar::<_, String>(
            "SELECT content FROM context_files WHERE channel_id = $1 AND path = $2",
        )
        .bind(channel_id.to_string())
        .bind(&path)
        .fetch_optional(db)
        .await
        {
            if !content.trim().is_empty() {
                out.push(format!("[Pinned: {path}]\n{content}"));
            }
        }
    }
    out
}

pub(crate) async fn mark_placeholder_failed(
    db: &PgPool,
    placeholder_id: Uuid,
) -> Result<Option<FailedPlaceholder>, sqlx::Error> {
    let Some(channel_id) = sqlx::query(
        "SELECT channel_id
         FROM messages
         WHERE msg_id = $1 AND is_partial = TRUE AND channel_seq IS NULL",
    )
    .bind(placeholder_id.to_string())
    .fetch_optional(db)
    .await?
    .and_then(|row| row.try_get::<String, _>("channel_id").ok())
    .and_then(|raw| raw.parse::<Uuid>().ok()) else {
        return Ok(None);
    };

    let mut tx = db.begin().await?;
    let seq = channel_seq::allocate(&mut tx, channel_id).await?;
    let result = sqlx::query(
        "UPDATE messages
         SET is_partial = FALSE,
             content = '[bot offline]',
             channel_seq = $2
         WHERE msg_id = $1 AND is_partial = TRUE AND channel_seq IS NULL",
    )
    .bind(placeholder_id.to_string())
    .bind(seq)
    .execute(&mut *tx)
    .await?;

    if result.rows_affected() == 0 {
        tx.rollback().await?;
        return Ok(None);
    }

    tx.commit().await?;

    Ok(Some(FailedPlaceholder {
        channel_id,
        channel_seq: seq,
    }))
}

/// A session's ACP root set: `(cwd, additional_dirs)` — the effective root set is
/// `[cwd, ...additional_dirs]`. `None` cwd ⇒ the connector uses its `default_cwd`.
type SessionWorkspace = (Option<String>, Vec<String>);

/// Read a session's stored `metadata.workspace` (the per-session ACP `cwd` +
/// `additionalDirectories`). Missing row / key ⇒ `(None, [])`, so the connector
/// falls back to its default_cwd. Best-effort: any DB error degrades to the default.
async fn load_session_workspace(db: &PgPool, provider_session_key: &str) -> SessionWorkspace {
    let ws = sqlx::query(
        "SELECT metadata->'workspace' AS ws FROM cheers_sessions
         WHERE provider_session_key = $1 LIMIT 1",
    )
    .bind(provider_session_key)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .and_then(|r| r.try_get::<Option<Value>, _>("ws").ok().flatten());
    match ws {
        Some(ws) => {
            let cwd = ws.get("cwd").and_then(Value::as_str).map(str::to_string);
            let additional_dirs = ws
                .get("additional_dirs")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            (cwd, additional_dirs)
        }
        None => (None, Vec::new()),
    }
}

#[allow(clippy::too_many_arguments)]
fn build_task_frame(
    task_id: Uuid,
    channel_id: Uuid,
    msg_id: Uuid,
    trigger_seq: i64,
    depth: i32,
    placeholder_msg_id: Uuid,
    provider_session_key: &str,
    session_id: Option<Uuid>,
    task_context: TaskContext,
    workspace: SessionWorkspace,
) -> Value {
    let trigger = if depth > 0 {
        "bot_message"
    } else {
        "user_message"
    };

    let (cwd, additional_dirs) = workspace;
    use cheers_bridge_protocol as proto;
    // wire-compat: msg_id duplicates trigger_msg_id, and the nested session ref
    // repeats session identifiers — deployed connectors read both shapes.
    crate::gateway::bridge_frames::frame_value(&proto::ControlInbound::Task {
        v: proto::BRIDGE_PROTOCOL_VERSION,
        task_id: task_id.to_string(),
        channel_id: channel_id.to_string(),
        trigger_msg_id: msg_id.to_string(),
        msg_id: Some(msg_id.to_string()),
        trigger_seq: Some(trigger_seq),
        depth: Some(depth),
        trigger: Some(trigger.to_string()),
        placeholder_msg_id: placeholder_msg_id.to_string(),
        provider_session_key: provider_session_key.to_string(),
        session_id: session_id.map(|id| id.to_string()),
        session_policy: Some(proto::SessionPolicy {
            on_missing: "create".to_string(),
            on_paused: "resume".to_string(),
            after_task: "keep_active".to_string(),
        }),
        trigger_message: Some(task_context.trigger_message),
        attachments: task_context
            .attachments
            .into_iter()
            .map(|a| {
                serde_json::from_value::<proto::AttachmentInfo>(a)
                    .expect("attachment objects fit AttachmentInfo (flatten extra)")
            })
            .collect(),
        pinned: task_context.pinned,
        // Per-session ACP root set. The connector re-validates against its
        // allowed_roots and uses default_cwd when cwd is absent (ACP: cwd is a
        // pure session/new argument, immutable for the session's lifetime).
        cwd,
        additional_dirs,
        binding_config: None,
        session: Some(proto::RuntimeSessionRef {
            id: session_id.map(|id| id.to_string()),
            provider_session_key: Some(provider_session_key.to_string()),
            provider_session_id: None,
            provider_account_id: None,
            provider_agent_id: None,
            primary_scope_type: None,
            primary_scope_id: None,
            task_scope_id: Some(task_id.to_string()),
            extra: Default::default(),
        }),
        enqueued_at: Some(chrono::Utc::now().to_rfc3339()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::bridge_frames::fixture::assert_matches_fixture;

    /// The `task` frame is pinned to the shared golden fixture (the same file
    /// the connector parses in its serde tests). `enqueued_at` is now() —
    /// stripped before comparing.
    #[test]
    fn task_frame_matches_fixture() {
        let frame = build_task_frame(
            Uuid::parse_str("99999999-aaaa-4bbb-8ccc-dddddddddddd").unwrap(),
            Uuid::parse_str("77777777-8888-4999-8aaa-bbbbbbbbbbbb").unwrap(),
            Uuid::parse_str("eeeeeeee-ffff-4000-8111-222222222222").unwrap(),
            42,
            0,
            Uuid::parse_str("33333333-4444-4555-8666-777777777777").unwrap(),
            "cheers:channel:77777777-8888-4999-8aaa-bbbbbbbbbbbb:bot:6f9619ff-8b86-4d01-b42d-00c04fc964ff",
            None,
            TaskContext {
                trigger_message: json!({
                    "msg_id": "eeeeeeee-ffff-4000-8111-222222222222",
                    "content": "hello bot",
                }),
                attachments: vec![json!({
                    "file_id": "file-1",
                    "filename": "notes.md",
                    "content_type": "text/markdown",
                    "size_bytes": 12,
                })],
                pinned: vec!["Always answer in English.".to_string()],
            },
            (Some("/workspace".to_string()), vec!["/data".to_string()]),
        );
        assert_matches_fixture(&frame, "control/to_connector/task.json", &["enqueued_at"]);
    }

    /// I4：同一 (trigger, bot) 必派生同一占位 id（重投收敛同一占位）。
    #[test]
    fn placeholder_id_is_deterministic() {
        let trigger = Uuid::new_v4();
        let bot = Uuid::new_v4();
        assert_eq!(
            derive_placeholder_id(trigger, bot),
            derive_placeholder_id(trigger, bot)
        );
    }

    /// 不同 trigger 或不同 bot → 不同占位 id（不会误合并两个任务）。
    #[test]
    fn placeholder_id_varies_by_inputs() {
        let trigger = Uuid::new_v4();
        let bot = Uuid::new_v4();
        let other = Uuid::new_v4();
        assert_ne!(
            derive_placeholder_id(trigger, bot),
            derive_placeholder_id(other, bot)
        );
        assert_ne!(
            derive_placeholder_id(trigger, bot),
            derive_placeholder_id(trigger, other)
        );
    }

    /// 占位 id 是 UUID v5（确定性命名空间散列，而非随机 v4）。
    #[test]
    fn placeholder_id_is_v5() {
        let id = derive_placeholder_id(Uuid::new_v4(), Uuid::new_v4());
        assert_eq!(id.get_version_num(), 5);
    }

    fn attachment_row(size_bytes: Option<i32>) -> AttachmentRow {
        AttachmentRow {
            file_id: "f1".to_string(),
            original_filename: Some("photo.png".to_string()),
            content_type: Some("image/png".to_string()),
            size_bytes,
            object_key: Some("uploads/f1/photo.png".to_string()),
            storage_bucket: None,
            status: "uploaded".to_string(),
            expired: false,
            md_path: None,
        }
    }

    /// 正常小图：uploaded、未过期、尺寸在单图/总预算内 → 允许内联。
    #[test]
    fn inline_allows_small_uploaded_image() {
        assert!(should_inline_media(
            &attachment_row(Some(1024)),
            MAX_INLINE_TOTAL_BYTES
        ));
    }

    /// 内联门禁的每个否决条件：无尺寸 / 超单图上限 / 超剩余预算 /
    /// staged（字节不在 S3）/ 已过期 / 缺 object_key。
    #[test]
    fn inline_rejects_ineligible_rows() {
        assert!(!should_inline_media(
            &attachment_row(None),
            MAX_INLINE_TOTAL_BYTES
        ));
        assert!(!should_inline_media(
            &attachment_row(Some(i32::MAX)),
            MAX_INLINE_TOTAL_BYTES
        ));
        assert!(!should_inline_media(&attachment_row(Some(1024)), 1023));

        let staged = AttachmentRow {
            status: "staged".to_string(),
            ..attachment_row(Some(1024))
        };
        assert!(!should_inline_media(&staged, MAX_INLINE_TOTAL_BYTES));

        let expired = AttachmentRow {
            expired: true,
            ..attachment_row(Some(1024))
        };
        assert!(!should_inline_media(&expired, MAX_INLINE_TOTAL_BYTES));

        let no_key = AttachmentRow {
            object_key: None,
            ..attachment_row(Some(1024))
        };
        assert!(!should_inline_media(&no_key, MAX_INLINE_TOTAL_BYTES));
    }
}

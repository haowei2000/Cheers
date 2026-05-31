pub mod activity;
pub mod channel_info;
pub mod context;
pub mod files;
pub mod fs;
pub mod members;
pub mod memory;
pub mod messages;
pub mod permission;

use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// resource_req 的入口分发器。
/// 收到帧后按 resource 字段路由到对应 handler。
pub async fn dispatch(db: &PgPool, bot_id: Uuid, frame: &Value) -> Value {
    let req_id = frame.get("req_id").and_then(|v| v.as_str()).unwrap_or("");
    let resource = frame.get("resource").and_then(|v| v.as_str()).unwrap_or("");
    let params = frame.get("params").cloned().unwrap_or(Value::Null);
    let session_id = frame
        .get("session_id")
        .or_else(|| params.get("session_id"))
        .and_then(|v| v.as_str());

    let result = match resource {
        // ── 读操作（仅需频道成员，不走 Grant）────────────────────────────
        "channel.info" => channel_info::handle(db, bot_id, &params).await,
        "channel.members" => members::handle(db, bot_id, &params).await,
        "channel.messages" => messages::handle_read(db, bot_id, &params).await,
        "channel.files" => files::handle_list(db, bot_id, &params).await,
        "channel.files.read" => files::handle_read(db, bot_id, &params).await,
        "channel.memory" => memory::handle_read(db, bot_id, &params).await,
        "channel.context" => context::handle(db, bot_id, &params).await,

        // ── mesh step 6：新增读操作 ───────────────────────────────────────
        "channel.activity.read" => activity::handle_read(db, bot_id, &params).await,
        "channel.messages.index" => activity::handle_index(db, bot_id, &params).await,
        "channel.messages.by-seq" => messages::handle_by_seq(db, bot_id, &params).await,
        "fs.ls" => fs::handle_ls(db, bot_id, &params).await,
        "fs.read" => fs::handle_read(db, bot_id, &params).await,

        // ── 写操作（频道成员 + Grant）────────────────────────────────────
        "channel.messages.create" => messages::handle_create(db, bot_id, &params, session_id).await,
        "channel.files.create" => files::handle_create(db, bot_id, &params, session_id).await,
        "channel.memory.update" => memory::handle_update(db, bot_id, &params, session_id).await,

        // ── mesh step 6：新增写操作（fs.*）───────────────────────────────
        "fs.write" => fs::handle_write(db, bot_id, &params, session_id).await,
        "fs.edit" => fs::handle_edit(db, bot_id, &params, session_id).await,
        "fs.append" => fs::handle_append(db, bot_id, &params, session_id).await,
        "fs.rm" => fs::handle_rm(db, bot_id, &params, session_id).await,
        "fs.mv" => fs::handle_mv(db, bot_id, &params, session_id).await,

        _ => Err(resource_error(
            "UNKNOWN_RESOURCE",
            format!("unknown resource: {resource}"),
        )),
    };

    match result {
        Ok(data) => json!({
            "type": "resource_res",
            "v": 1,
            "req_id": req_id,
            "ok": true,
            "data": data,
        }),
        Err((code, msg)) => json!({
            "type": "resource_res",
            "v": 1,
            "req_id": req_id,
            "ok": false,
            "code": code,
            "error": msg,
        }),
    }
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

pub type ResourceResult = Result<Value, (String, String)>;

pub fn resource_error(code: &str, msg: impl Into<String>) -> (String, String) {
    (code.to_string(), msg.into())
}

pub fn not_member() -> (String, String) {
    resource_error("NOT_MEMBER", "bot is not a member of this channel")
}

pub fn permission_denied(reason: &str) -> (String, String) {
    resource_error("PERMISSION_DENIED", reason)
}

pub fn not_found(what: &str) -> (String, String) {
    resource_error("NOT_FOUND", format!("{what} not found"))
}

/// 验证 bot 是否是指定频道的成员（读操作的权限检查）。
pub async fn check_bot_in_channel(
    db: &PgPool,
    bot_id: Uuid,
    channel_id: Uuid,
) -> Result<(), (String, String)> {
    let row = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM channel_memberships
            WHERE channel_id = $1 AND member_id = $2 AND member_type = 'bot'
        ) AS is_member",
    )
    .bind(channel_id.to_string())
    .bind(bot_id.to_string())
    .fetch_one(db)
    .await
    .map_err(|_| resource_error("INTERNAL_ERROR", "db error"))?;

    let is_member: bool = row.try_get("is_member").unwrap_or(false);
    if is_member {
        Ok(())
    } else {
        Err(not_member())
    }
}

/// 写操作：验证频道成员 + Grant evaluate()。
pub async fn check_write_permission(
    db: &PgPool,
    bot_id: Uuid,
    channel_id: Uuid,
    resource: &str,
    action: &str,
    session_id: Option<&str>,
) -> Result<(), (String, String)> {
    // 1. 频道成员检查
    check_bot_in_channel(db, bot_id, channel_id).await?;

    // 2. Grant 检查
    let result = permission::evaluate(
        db,
        &bot_id.to_string(),
        resource,
        action,
        Some(&channel_id.to_string()),
        None,
        None,
        session_id,
    )
    .await
    .map_err(|_| resource_error("INTERNAL_ERROR", "permission check failed"))?;

    if result.is_allowed() {
        Ok(())
    } else {
        Err(permission_denied(
            result.reason.as_deref().unwrap_or("permission denied"),
        ))
    }
}

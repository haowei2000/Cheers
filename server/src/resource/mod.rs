pub mod activity;
pub mod channel_info;
pub mod context;
pub mod files;
pub mod fs;
pub mod members;
pub mod messages;

use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrincipalType {
    User,
    Bot,
}

impl PrincipalType {
    pub fn as_member_type(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Bot => "bot",
        }
    }

    pub fn as_sender_type(self) -> &'static str {
        self.as_member_type()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Principal {
    pub principal_type: PrincipalType,
    pub principal_id: Uuid,
}

impl Principal {
    pub fn bot(bot_id: Uuid) -> Self {
        Self {
            principal_type: PrincipalType::Bot,
            principal_id: bot_id,
        }
    }

    #[allow(dead_code)]
    pub fn user(user_id: Uuid) -> Self {
        Self {
            principal_type: PrincipalType::User,
            principal_id: user_id,
        }
    }

    pub fn member_type(self) -> &'static str {
        self.principal_type.as_member_type()
    }

    pub fn sender_type(self) -> &'static str {
        self.principal_type.as_sender_type()
    }
}

#[derive(Debug, Clone)]
pub struct ChannelMembership {
    pub role: String,
}

/// resource_req 的入口分发器。
/// 收到帧后按 resource 字段路由到对应 handler。
pub async fn dispatch(db: &PgPool, principal: Principal, frame: &Value) -> Value {
    let req_id = frame.get("req_id").and_then(|v| v.as_str()).unwrap_or("");
    let resource = frame.get("resource").and_then(|v| v.as_str()).unwrap_or("");
    let params = frame.get("params").cloned().unwrap_or(Value::Null);

    let result = match resource {
        // ── 读操作（频道成员可读）──────────────────────────────────────
        "channel.info" => channel_info::handle(db, &principal, &params).await,
        "channel.members" => members::handle(db, &principal, &params).await,
        "channel.messages" => messages::handle_read(db, &principal, &params).await,
        "channel.files" => files::handle_list(db, &principal, &params).await,
        "channel.files.read" => files::handle_read(db, &principal, &params).await,
        "channel.context" => context::handle(db, &principal, &params).await,

        // ── mesh step 6：新增读操作 ───────────────────────────────────────
        "channel.activity.read" => activity::handle_read(db, &principal, &params).await,
        "channel.messages.index" => activity::handle_index(db, &principal, &params).await,
        "channel.messages.by-seq" => messages::handle_by_seq(db, &principal, &params).await,
        "fs.ls" => fs::handle_ls(db, &principal, &params).await,
        "fs.read" => fs::handle_read(db, &principal, &params).await,

        // ── 写操作（频道成员 role 可写）────────────────────────────────
        "channel.messages.create" => messages::handle_create(db, &principal, &params).await,
        "channel.files.create" => files::handle_create(db, &principal, &params).await,

        // ── mesh step 6：新增写操作（fs.*）───────────────────────────────
        "fs.write" => fs::handle_write(db, &principal, &params).await,
        "fs.edit" => fs::handle_edit(db, &principal, &params).await,
        "fs.append" => fs::handle_append(db, &principal, &params).await,
        "fs.rm" => fs::handle_rm(db, &principal, &params).await,
        "fs.mv" => fs::handle_mv(db, &principal, &params).await,

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
    resource_error("NOT_MEMBER", "principal is not a member of this channel")
}

pub fn permission_denied(reason: &str) -> (String, String) {
    resource_error("PERMISSION_DENIED", reason)
}

pub fn not_found(what: &str) -> (String, String) {
    resource_error("NOT_FOUND", format!("{what} not found"))
}

pub async fn authorize_channel_read(
    db: &PgPool,
    principal: &Principal,
    channel_id: Uuid,
) -> Result<ChannelMembership, (String, String)> {
    let row = sqlx::query(
        "SELECT role
         FROM channel_memberships
         WHERE channel_id = $1 AND member_id = $2 AND member_type = $3",
    )
    .bind(channel_id.to_string())
    .bind(principal.principal_id.to_string())
    .bind(principal.member_type())
    .fetch_optional(db)
    .await
    .map_err(|_| resource_error("INTERNAL_ERROR", "db error"))?;

    row.map(|row| ChannelMembership {
        role: row
            .try_get::<String, _>("role")
            .unwrap_or_else(|_| "member".to_string()),
    })
    .ok_or_else(not_member)
}

pub async fn authorize_channel_write(
    db: &PgPool,
    principal: &Principal,
    channel_id: Uuid,
) -> Result<ChannelMembership, (String, String)> {
    let membership = authorize_channel_read(db, principal, channel_id).await?;

    if role_can_write(&membership.role) {
        Ok(membership)
    } else {
        Err(permission_denied("channel role is read-only"))
    }
}

pub fn role_can_write(role: &str) -> bool {
    matches!(role, "owner" | "admin" | "member")
}

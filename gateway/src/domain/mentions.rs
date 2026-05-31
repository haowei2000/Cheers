//! @mention 解析与 `message_mentions` 写入（mesh step 2 依赖）。
//!
//! 在消息写入事务内同步执行，结果留在内存供 `resolve_bot_triggers` 直接消费——
//! dispatch 路径零额外查询。`message_mentions` 表只用于 @me 反查通知。
use sqlx::PgPool;
use uuid::Uuid;

/// 单条 mention 记录（多态，与 channel_memberships.member_* 同形）。
#[derive(Debug, Clone)]
pub struct Mention {
    pub member_id: Uuid,
    pub member_type: MemberType,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemberType {
    User,
    Bot,
}

impl MemberType {
    pub fn as_str(&self) -> &'static str {
        match self {
            MemberType::User => "user",
            MemberType::Bot  => "bot",
        }
    }
}

/// 解析消息内容中的 `@mention`，返回内存结果（供 dispatch 直接用）。
///
/// 格式约定：`@<username>` 或 `@<display_name>`；实现时查 `users` + `bot_accounts`
/// 表解析 name → id，需要频道成员范围内匹配。
pub async fn parse(
    db: &PgPool,
    channel_id: Uuid,
    content: &str,
) -> Vec<Mention> {
    todo!("mesh step 2: parse @mentions in content, resolve to (member_id, member_type) within channel")
}

/// 在事务内将解析结果批量写入 `message_mentions`。
/// 调用方：`create_message` 事务体内，与消息 INSERT 同一事务。
pub async fn insert_batch(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    msg_id: Uuid,
    mentions: &[Mention],
) -> Result<(), sqlx::Error> {
    todo!("mesh step 2: INSERT INTO message_mentions (msg_id, member_id, member_type) batch")
}

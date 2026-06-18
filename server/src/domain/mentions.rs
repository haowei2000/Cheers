//! @mention 验证与 `message_mentions` 写入。
//!
//! 两种输入方式：
//! - `mention_ids`（UUID）：程序化调用（前端、WebSocket 帧）用此方式，精确无歧义。
//! - `mention_names`（username / display_name）：LLM agent 通过 MCP 调用时用此方式，
//!   gateway 做 name → UUID 解析，查 `channel_memberships` + `users` / `bot_accounts`。
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// 单条 mention 记录（多态，与 channel_memberships.member_* 同形）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mention {
    pub member_id: Uuid,
    pub member_type: MemberType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberType {
    User,
    Bot,
}

impl MemberType {
    pub fn as_str(&self) -> &'static str {
        match self {
            MemberType::User => "user",
            MemberType::Bot => "bot",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MentionParseError {
    #[error("mention target is not a channel member: {member_id}")]
    InvalidMember { member_id: Uuid },

    #[error("mention name not found in channel: {name}")]
    NameNotFound { name: String },

    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

/// 验证 mention_ids 都是频道成员，从 channel_memberships 取 member_type。
pub async fn validate_mention_ids(
    db: &PgPool,
    channel_id: Uuid,
    mention_ids: &[Uuid],
) -> Result<Vec<Mention>, MentionParseError> {
    let mut mentions = Vec::new();
    for &member_id in mention_ids {
        let row = sqlx::query(
            "SELECT member_type FROM channel_memberships
             WHERE channel_id = $1 AND member_id = $2
             LIMIT 1",
        )
        .bind(channel_id.to_string())
        .bind(member_id.to_string())
        .fetch_optional(db)
        .await?;

        let Some(row) = row else {
            return Err(MentionParseError::InvalidMember { member_id });
        };

        let member_type = match row.try_get::<String, _>("member_type").as_deref() {
            Ok("bot") => MemberType::Bot,
            Ok("user") => MemberType::User,
            _ => return Err(MentionParseError::InvalidMember { member_id }),
        };

        push_unique(&mut mentions, member_id, member_type);
    }
    Ok(mentions)
}

/// 按 username / display_name 查找频道成员，返回解析结果。
/// 用于 LLM agent 通过 MCP 传 `mention_names` 的场景。
pub async fn resolve_mention_names(
    db: &PgPool,
    channel_id: Uuid,
    names: &[String],
) -> Result<Vec<Mention>, MentionParseError> {
    let mut mentions = Vec::new();
    for name in names {
        let row = sqlx::query(
            "SELECT cm.member_id, cm.member_type
             FROM channel_memberships cm
             LEFT JOIN users u
               ON u.user_id = cm.member_id AND cm.member_type = 'user'
             LEFT JOIN bot_accounts ba
               ON ba.bot_id = cm.member_id AND cm.member_type = 'bot'
             WHERE cm.channel_id = $1
               AND (
                 (cm.member_type = 'user' AND (u.username = $2 OR u.display_name = $2))
                 OR
                 (cm.member_type = 'bot' AND (ba.username = $2 OR ba.display_name = $2))
               )
             LIMIT 1",
        )
        .bind(channel_id.to_string())
        .bind(name)
        .fetch_optional(db)
        .await?;

        let Some(row) = row else {
            return Err(MentionParseError::NameNotFound { name: name.clone() });
        };

        let member_id: Uuid = row
            .try_get::<String, _>("member_id")
            .ok()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| MentionParseError::NameNotFound { name: name.clone() })?;

        let member_type = match row.try_get::<String, _>("member_type").as_deref() {
            Ok("bot") => MemberType::Bot,
            Ok("user") => MemberType::User,
            _ => return Err(MentionParseError::NameNotFound { name: name.clone() }),
        };

        push_unique(&mut mentions, member_id, member_type);
    }
    Ok(mentions)
}

/// 在事务内批量写入 `message_mentions`（首次写入）。
pub async fn insert_batch(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    msg_id: Uuid,
    mentions: &[Mention],
) -> Result<(), sqlx::Error> {
    for mention in mentions {
        sqlx::query(
            "INSERT INTO message_mentions (msg_id, member_id, member_type)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING",
        )
        .bind(msg_id.to_string())
        .bind(mention.member_id.to_string())
        .bind(mention.member_type.as_str())
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/// 替换消息的 mentions（DELETE + INSERT）。用于 bot placeholder finalize。
pub async fn replace_batch(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    msg_id: Uuid,
    mentions: &[Mention],
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM message_mentions WHERE msg_id = $1")
        .bind(msg_id.to_string())
        .execute(&mut **tx)
        .await?;
    insert_batch(tx, msg_id, mentions).await
}

fn push_unique(mentions: &mut Vec<Mention>, member_id: Uuid, member_type: MemberType) {
    if !mentions
        .iter()
        .any(|m| m.member_type == member_type && m.member_id == member_id)
    {
        mentions.push(Mention {
            member_id,
            member_type,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 同一 (member_id, member_type) 去重，重复 @ 同一成员只记一次。
    #[test]
    fn push_unique_dedupes_same_member() {
        let mut v = Vec::new();
        let id = Uuid::new_v4();
        push_unique(&mut v, id, MemberType::User);
        push_unique(&mut v, id, MemberType::User);
        assert_eq!(v.len(), 1);
    }

    /// 同 id 但 type 不同算两个不同 mention（user 与 bot 多态共用 id 空间）。
    #[test]
    fn push_unique_keeps_distinct_type_same_id() {
        let mut v = Vec::new();
        let id = Uuid::new_v4();
        push_unique(&mut v, id, MemberType::User);
        push_unique(&mut v, id, MemberType::Bot);
        assert_eq!(v.len(), 2);
    }

    /// 不同 id 各自保留。
    #[test]
    fn push_unique_keeps_distinct_ids() {
        let mut v = Vec::new();
        push_unique(&mut v, Uuid::new_v4(), MemberType::User);
        push_unique(&mut v, Uuid::new_v4(), MemberType::User);
        assert_eq!(v.len(), 2);
    }
}

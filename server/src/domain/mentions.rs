//! @mention 解析与 `message_mentions` 写入（mesh step 2 依赖）。
//!
//! 在消息写入事务内同步执行，结果留在内存供 `resolve_bot_triggers` 直接消费——
//! dispatch 路径零额外查询。`message_mentions` 表只用于 @me 反查通知。
use sqlx::{PgPool, Row};
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
            MemberType::Bot => "bot",
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
    let mut mentions = Vec::new();

    for token in content.split_whitespace() {
        if token.is_empty() {
            continue;
        }

        if token.starts_with("<@") && token.ends_with('>') {
            let inner = token.trim_start_matches("<@").trim_end_matches('>');
            let Some((kind, value)) = inner.split_once(':') else {
                continue;
            };

            if value.is_empty() {
                continue;
            }

            if let Some(member_id) = resolve_typed_member_id(db, channel_id, kind, value).await {
                push_unique(&mut mentions, member_id, kind_to_member_type(kind));
                continue;
            }
            if kind == "bot" {
                if let Some(member_id) = resolve_bot_id(db, channel_id, value).await {
                    push_unique(&mut mentions, member_id, MemberType::Bot);
                }
            } else if kind == "user" {
                if let Some(member_id) = resolve_user_id(db, channel_id, value).await {
                    push_unique(&mut mentions, member_id, MemberType::User);
                }
            }

            continue;
        }

        if !token.starts_with('@') {
            continue;
        }

        let token = token
            .trim_start_matches('@')
            .trim_matches(|c: char| !c.is_alphanumeric() && !matches!(c, '_' | '-' | '.'));

        if token.is_empty() {
            continue;
        }

        if let Some(member_id) = resolve_user_id(db, channel_id, token).await {
            push_unique(&mut mentions, member_id, MemberType::User);
            continue;
        }
        if let Some(member_id) = resolve_bot_id(db, channel_id, token).await {
            push_unique(&mut mentions, member_id, MemberType::Bot);
        }
    }

    mentions
}

/// 在事务内将解析结果批量写入 `message_mentions`。
/// 调用方：`create_message` 事务体内，与消息 INSERT 同一事务。
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
        .execute(tx)
        .await?;
    }

    Ok(())
}

async fn resolve_user_id(
    db: &PgPool,
    channel_id: Uuid,
    token: &str,
) -> Option<Uuid> {
    let token = token.trim();
    sqlx::query("SELECT u.user_id
         FROM channel_memberships cm
         JOIN users u ON u.user_id = cm.member_id
         WHERE cm.channel_id = $1
           AND cm.member_type = 'user'
           AND (u.username = $2 OR u.display_name = $2)
         LIMIT 1")
        .bind(channel_id.to_string())
        .bind(token)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .and_then(|row| row.try_get::<String, _>("user_id").ok())
        .and_then(|id| Uuid::parse_str(&id).ok())
}

async fn resolve_typed_member_id(
    db: &PgPool,
    channel_id: Uuid,
    kind: &str,
    value: &str,
) -> Option<Uuid> {
    let member_id = if kind == "bot" || kind == "user" {
        Uuid::parse_str(value).ok()
    } else {
        None
    }?;

    let row = if kind == "bot" {
        sqlx::query("SELECT ba.bot_id
             FROM channel_memberships cm
             JOIN bot_accounts ba ON ba.bot_id = cm.member_id
             WHERE cm.channel_id = $1
               AND cm.member_type = 'bot'
               AND ba.bot_id = $2
             LIMIT 1")
            .bind(channel_id.to_string())
            .bind(member_id.to_string())
            .fetch_optional(db)
            .await
            .ok()
            .flatten()
            .and_then(|row| row.try_get::<String, _>("bot_id").ok())
            .and_then(|id| Uuid::parse_str(&id).ok())
    } else {
        sqlx::query("SELECT u.user_id
             FROM channel_memberships cm
             JOIN users u ON u.user_id = cm.member_id
             WHERE cm.channel_id = $1
               AND cm.member_type = 'user'
               AND u.user_id = $2
             LIMIT 1")
            .bind(channel_id.to_string())
            .bind(member_id.to_string())
            .fetch_optional(db)
            .await
            .ok()
            .flatten()
            .and_then(|row| row.try_get::<String, _>("user_id").ok())
            .and_then(|id| Uuid::parse_str(&id).ok())
    };

    row
}

fn kind_to_member_type(kind: &str) -> MemberType {
    if kind == "bot" {
        MemberType::Bot
    } else {
        MemberType::User
    }
}

fn push_unique(mentions: &mut Vec<Mention>, member_id: Uuid, member_type: MemberType) {
    if mentions.iter().any(|m| m.member_type == member_type && m.member_id == member_id) {
        return;
    }

    mentions.push(Mention {
        member_id,
        member_type,
    });
}

async fn resolve_bot_id(
    db: &PgPool,
    channel_id: Uuid,
    token: &str,
) -> Option<Uuid> {
    let token = token.trim();
    sqlx::query("SELECT ba.bot_id
         FROM channel_memberships cm
         JOIN bot_accounts ba ON ba.bot_id = cm.member_id
         WHERE cm.channel_id = $1
           AND cm.member_type = 'bot'
           AND (ba.username = $2 OR ba.display_name = $2)
         LIMIT 1")
        .bind(channel_id.to_string())
        .bind(token)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .and_then(|row| row.try_get::<String, _>("bot_id").ok())
        .and_then(|id| Uuid::parse_str(&id).ok())
}

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
/// 单次 `member_id = ANY(...)` 查询 + 内存比对，避免每个 mention 一次 DB 往返
/// （群 @ 最多 500 个成员，逐条查询会在持有频道序列化锁的事务内堆积往返）。
pub async fn validate_mention_ids(
    db: &PgPool,
    channel_id: Uuid,
    mention_ids: &[Uuid],
) -> Result<Vec<Mention>, MentionParseError> {
    if mention_ids.is_empty() {
        return Ok(Vec::new());
    }
    let id_strs: Vec<String> = mention_ids.iter().map(|id| id.to_string()).collect();
    let rows = sqlx::query(
        "SELECT member_id, member_type FROM channel_memberships
         WHERE channel_id = $1 AND member_id = ANY($2)",
    )
    .bind(channel_id.to_string())
    .bind(&id_strs)
    .fetch_all(db)
    .await?;

    // member_id → MemberType（仅收录 user/bot；未知 type 视同不存在 → InvalidMember）。
    let mut type_by_id: std::collections::HashMap<Uuid, MemberType> =
        std::collections::HashMap::new();
    for row in &rows {
        let mid = row
            .try_get::<String, _>("member_id")
            .ok()
            .and_then(|s| s.parse::<Uuid>().ok());
        let mty = match row.try_get::<String, _>("member_type").as_deref() {
            Ok("bot") => Some(MemberType::Bot),
            Ok("user") => Some(MemberType::User),
            _ => None,
        };
        if let (Some(mid), Some(mty)) = (mid, mty) {
            type_by_id.insert(mid, mty);
        }
    }

    // 按输入顺序遍历——保留“首个非成员即报错”的既有语义与去重顺序。
    let mut mentions = Vec::new();
    for &member_id in mention_ids {
        let Some(&member_type) = type_by_id.get(&member_id) else {
            return Err(MentionParseError::InvalidMember { member_id });
        };
        push_unique(&mut mentions, member_id, member_type);
    }
    Ok(mentions)
}

/// Group-mention scope: a reserved `mention_names` token that expands to many
/// channel members instead of resolving to one. Expansion produces concrete
/// `(member_id, member_type)` rows — the `message_mentions` /
/// `channel_memberships` CHECK constraints only allow `user`/`bot`, so there is
/// no synthetic "group" member type on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GroupScope {
    /// `@all` / `@everyone` / `@here`: every member (users + bots).
    All,
    /// `@bots`: every bot member.
    Bots,
    /// `@humans` / `@users`: every human member.
    Humans,
}

/// Map a `mention_names` entry to a [`GroupScope`] when it is a reserved group
/// token (case-insensitive, tolerates a leading `@`). `@here` currently aliases
/// `@all`: there is no queryable presence signal at message-write time, so it
/// cannot yet mean "online members only" — documented, not silently wrong. A
/// token always wins over a member who happens to share the name (rare; e.g. a
/// member literally named "bots").
fn group_mention_scope(name: &str) -> Option<GroupScope> {
    match name
        .trim()
        .trim_start_matches('@')
        .to_ascii_lowercase()
        .as_str()
    {
        "all" | "everyone" | "here" => Some(GroupScope::All),
        "bots" => Some(GroupScope::Bots),
        "humans" | "users" => Some(GroupScope::Humans),
        _ => None,
    }
}

/// Expand a group token into the matching channel members. Capped at
/// [`GROUP_MENTION_CAP`] rows so a group mention in a very large channel can't
/// balloon the `message_mentions` insert; a truncated expansion is logged so the
/// cap is never silent. Downstream self-@ filtering (see `chains::mentioned_bots`)
/// keeps a bot's own `@all` from re-triggering itself, so the author is included
/// here rather than special-cased.
async fn expand_group_mention(
    db: &PgPool,
    channel_id: Uuid,
    scope: GroupScope,
) -> Result<Vec<Mention>, MentionParseError> {
    let type_filter = match scope {
        GroupScope::All => None,
        GroupScope::Bots => Some("bot"),
        GroupScope::Humans => Some("user"),
    };
    let rows = sqlx::query(
        "SELECT member_id, member_type FROM channel_memberships
         WHERE channel_id = $1 AND ($2::text IS NULL OR member_type = $2)
         LIMIT $3",
    )
    .bind(channel_id.to_string())
    .bind(type_filter)
    .bind(GROUP_MENTION_CAP + 1)
    .fetch_all(db)
    .await?;

    if rows.len() as i64 > GROUP_MENTION_CAP {
        tracing::warn!(
            channel_id = %channel_id,
            scope = ?scope,
            cap = GROUP_MENTION_CAP,
            "group mention expansion hit the member cap; some members were not mentioned"
        );
    }

    let mut mentions = Vec::new();
    for row in rows.iter().take(GROUP_MENTION_CAP as usize) {
        let Some(member_id) = row
            .try_get::<String, _>("member_id")
            .ok()
            .and_then(|s| s.parse().ok())
        else {
            continue;
        };
        let member_type = match row.try_get::<String, _>("member_type").as_deref() {
            Ok("bot") => MemberType::Bot,
            Ok("user") => MemberType::User,
            _ => continue,
        };
        push_unique(&mut mentions, member_id, member_type);
    }
    Ok(mentions)
}

/// Max members a single group token expands to (per token). Bounds the
/// `message_mentions` insert; the per-channel bot-dispatch budget
/// (`ratelimit::bot_dispatch_limiter`) separately bounds how many of those are
/// actually triggered.
const GROUP_MENTION_CAP: i64 = 500;

/// 按 username / display_name 查找频道成员，返回解析结果。
/// 用于 LLM agent 通过 MCP 传 `mention_names` 的场景。
///
/// Reserved group tokens (`@all`/`@everyone`/`@here`, `@bots`, `@humans`/`@users`)
/// expand to every matching member instead of resolving to one; see
/// [`group_mention_scope`].
pub async fn resolve_mention_names(
    db: &PgPool,
    channel_id: Uuid,
    names: &[String],
) -> Result<Vec<Mention>, MentionParseError> {
    let mut mentions = Vec::new();
    for name in names {
        if let Some(scope) = group_mention_scope(name) {
            for mention in expand_group_mention(db, channel_id, scope).await? {
                push_unique(&mut mentions, mention.member_id, mention.member_type);
            }
            continue;
        }
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
/// 单条 `unnest` 多行 INSERT——群 @ 时把最多 500 次往返压成一次，缩短持有频道
/// 序列化锁（channel_seq 行锁）的窗口。
pub async fn insert_batch(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    msg_id: Uuid,
    mentions: &[Mention],
) -> Result<(), sqlx::Error> {
    if mentions.is_empty() {
        return Ok(());
    }
    let member_ids: Vec<String> = mentions.iter().map(|m| m.member_id.to_string()).collect();
    let member_types: Vec<String> = mentions
        .iter()
        .map(|m| m.member_type.as_str().to_string())
        .collect();
    sqlx::query(
        "INSERT INTO message_mentions (msg_id, member_id, member_type)
         SELECT $1, u.id, u.ty
         FROM unnest($2::text[], $3::text[]) AS u(id, ty)
         ON CONFLICT DO NOTHING",
    )
    .bind(msg_id.to_string())
    .bind(&member_ids)
    .bind(&member_types)
    .execute(&mut **tx)
    .await?;
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

    /// Group tokens map to the right scope, case-insensitively and tolerating a
    /// leading `@`; `@here` aliases `@all`.
    #[test]
    fn group_scope_recognizes_reserved_tokens() {
        for token in ["all", "everyone", "here", "ALL", "@Everyone", " @HERE "] {
            assert_eq!(group_mention_scope(token), Some(GroupScope::All), "{token}");
        }
        assert_eq!(group_mention_scope("bots"), Some(GroupScope::Bots));
        assert_eq!(group_mention_scope("@Bots"), Some(GroupScope::Bots));
        assert_eq!(group_mention_scope("humans"), Some(GroupScope::Humans));
        assert_eq!(group_mention_scope("users"), Some(GroupScope::Humans));
    }

    /// An ordinary member name is not a group token — it falls through to the
    /// single-member lookup.
    #[test]
    fn group_scope_ignores_ordinary_names() {
        for name in ["helper", "Alice", "bot", "human", "all-stars", ""] {
            assert_eq!(group_mention_scope(name), None, "{name}");
        }
    }
}

//! @mention 验证与 `message_mentions` 写入（mesh step 2）。
//!
//! 人类消息：前端显式传 `mention_ids`（用户点击 mention 按钮产生），服务端只做成员验证。
//! Bot 消息：内容可能含遗留裸 `@name`，经 `normalize_bot_content` 改写成 token 后存库。
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
    #[error("mention target is not a channel member: {member_type}:{member_id}")]
    InvalidMember {
        member_type: &'static str,
        member_id: Uuid,
    },

    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

#[derive(Debug, Clone)]
pub struct NormalizedMentions {
    pub content: String,
    pub mentions: Vec<Mention>,
}

#[derive(Debug, Clone)]
struct MentionTokenSpan {
    start: usize,
    end: usize,
    mention: Mention,
}

#[derive(Debug, Clone)]
struct BareMentionReplacement {
    start: usize,
    end: usize,
    replacement: String,
    mention: Mention,
}

/// 验证前端传来的 mention_ids 都是频道成员，并从 channel_memberships 查出对应 member_type。
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
            return Err(MentionParseError::InvalidMember {
                member_type: "unknown",
                member_id,
            });
        };

        let member_type = match row.try_get::<String, _>("member_type").as_deref() {
            Ok("bot") => MemberType::Bot,
            Ok("user") => MemberType::User,
            _ => {
                return Err(MentionParseError::InvalidMember {
                    member_type: "unknown",
                    member_id,
                })
            }
        };

        push_unique(&mut mentions, member_id, member_type);
    }
    Ok(mentions)
}

/// Bot-authored content may contain legacy bare `@name`; rewrite resolved names to tokens.
pub async fn normalize_bot_content(
    db: &PgPool,
    channel_id: Uuid,
    content: &str,
) -> Result<NormalizedMentions, MentionParseError> {
    let token_spans = scan_mention_token_spans(content);
    let mut mentions = collect_unique_mentions(token_spans.iter().map(|span| span.mention));
    ensure_mentions_in_channel(db, channel_id, &mentions).await?;

    let replacements = resolve_bare_mention_replacements(db, channel_id, content, &token_spans)
        .await
        .map_err(MentionParseError::Db)?;
    for replacement in &replacements {
        push_unique(
            &mut mentions,
            replacement.mention.member_id,
            replacement.mention.member_type,
        );
    }

    Ok(NormalizedMentions {
        content: apply_replacements(content, &replacements),
        mentions,
    })
}

#[cfg(test)]
fn scan_tokens(content: &str) -> Vec<Mention> {
    collect_unique_mentions(
        scan_mention_token_spans(content)
            .into_iter()
            .map(|span| span.mention),
    )
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
        .execute(&mut **tx)
        .await?;
    }

    Ok(())
}

/// 替换某条消息的 mentions。用于 bot placeholder finalize。
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

async fn ensure_mentions_in_channel(
    db: &PgPool,
    channel_id: Uuid,
    mentions: &[Mention],
) -> Result<(), MentionParseError> {
    for mention in mentions {
        if !member_exists(db, channel_id, *mention).await? {
            return Err(MentionParseError::InvalidMember {
                member_type: mention.member_type.as_str(),
                member_id: mention.member_id,
            });
        }
    }

    Ok(())
}

async fn member_exists(
    db: &PgPool,
    channel_id: Uuid,
    mention: Mention,
) -> Result<bool, sqlx::Error> {
    sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM channel_memberships
            WHERE channel_id = $1 AND member_id = $2 AND member_type = $3
        ) AS ok",
    )
    .bind(channel_id.to_string())
    .bind(mention.member_id.to_string())
    .bind(mention.member_type.as_str())
    .fetch_one(db)
    .await?
    .try_get::<bool, _>("ok")
}

fn scan_mention_token_spans(content: &str) -> Vec<MentionTokenSpan> {
    let mut spans = Vec::new();
    let mut offset = 0;

    while let Some(relative_start) = content[offset..].find("<@") {
        let start = offset + relative_start;
        let Some((member_type, id_start)) = token_kind_at(content, start) else {
            offset = start + 2;
            continue;
        };

        let Some(relative_end) = content[id_start..].find('>') else {
            break;
        };
        let end = id_start + relative_end;
        let raw_id = &content[id_start..end];

        if let Ok(member_id) = Uuid::parse_str(raw_id) {
            spans.push(MentionTokenSpan {
                start,
                end: end + 1,
                mention: Mention {
                    member_id,
                    member_type,
                },
            });
        }

        offset = end + 1;
    }

    spans
}

fn token_kind_at(content: &str, start: usize) -> Option<(MemberType, usize)> {
    const BOT_PREFIX: &str = "<@bot:";
    const USER_PREFIX: &str = "<@user:";

    if content[start..].starts_with(BOT_PREFIX) {
        Some((MemberType::Bot, start + BOT_PREFIX.len()))
    } else if content[start..].starts_with(USER_PREFIX) {
        Some((MemberType::User, start + USER_PREFIX.len()))
    } else {
        None
    }
}

async fn resolve_bare_mention_replacements(
    db: &PgPool,
    channel_id: Uuid,
    content: &str,
    token_spans: &[MentionTokenSpan],
) -> Result<Vec<BareMentionReplacement>, sqlx::Error> {
    let mut replacements = Vec::new();

    for (start, ch) in content.char_indices() {
        if ch != '@'
            || inside_token_span(start, token_spans)
            || has_name_char_before(content, start)
        {
            continue;
        }

        let name_start = start + ch.len_utf8();
        let name_end = mention_name_end(content, name_start);
        if name_end == name_start {
            continue;
        }

        let token = &content[name_start..name_end];
        if let Some(mention) = resolve_legacy_member(db, channel_id, token).await? {
            replacements.push(BareMentionReplacement {
                start,
                end: name_end,
                replacement: format!("<@{}:{}>", mention.member_type.as_str(), mention.member_id),
                mention,
            });
        }
    }

    Ok(replacements)
}

async fn resolve_legacy_member(
    db: &PgPool,
    channel_id: Uuid,
    token: &str,
) -> Result<Option<Mention>, sqlx::Error> {
    if let Some(member_id) = resolve_user_id(db, channel_id, token).await? {
        return Ok(Some(Mention {
            member_id,
            member_type: MemberType::User,
        }));
    }

    if let Some(member_id) = resolve_bot_id(db, channel_id, token).await? {
        return Ok(Some(Mention {
            member_id,
            member_type: MemberType::Bot,
        }));
    }

    Ok(None)
}

fn inside_token_span(index: usize, token_spans: &[MentionTokenSpan]) -> bool {
    token_spans
        .iter()
        .any(|span| index >= span.start && index < span.end)
}

fn has_name_char_before(content: &str, index: usize) -> bool {
    content[..index]
        .chars()
        .next_back()
        .is_some_and(is_mention_name_char)
}

fn mention_name_end(content: &str, start: usize) -> usize {
    let mut end = start;
    for (relative_index, ch) in content[start..].char_indices() {
        if !is_mention_name_char(ch) {
            break;
        }
        end = start + relative_index + ch.len_utf8();
    }
    end
}

fn is_mention_name_char(ch: char) -> bool {
    ch.is_alphanumeric() || matches!(ch, '_' | '-' | '.')
}

fn apply_replacements(content: &str, replacements: &[BareMentionReplacement]) -> String {
    if replacements.is_empty() {
        return content.to_string();
    }

    let mut out = String::with_capacity(content.len());
    let mut cursor = 0;
    for replacement in replacements {
        out.push_str(&content[cursor..replacement.start]);
        out.push_str(&replacement.replacement);
        cursor = replacement.end;
    }
    out.push_str(&content[cursor..]);
    out
}

fn collect_unique_mentions(mentions: impl IntoIterator<Item = Mention>) -> Vec<Mention> {
    let mut unique = Vec::new();
    for mention in mentions {
        push_unique(&mut unique, mention.member_id, mention.member_type);
    }
    unique
}

async fn resolve_user_id(
    db: &PgPool,
    channel_id: Uuid,
    token: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    let token = token.trim();
    Ok(sqlx::query(
        "SELECT u.user_id
         FROM channel_memberships cm
         JOIN users u ON u.user_id = cm.member_id
         WHERE cm.channel_id = $1
           AND cm.member_type = 'user'
           AND (u.username = $2 OR u.display_name = $2)
         LIMIT 1",
    )
    .bind(channel_id.to_string())
    .bind(token)
    .fetch_optional(db)
    .await?
    .and_then(|row| row.try_get::<String, _>("user_id").ok())
    .and_then(|id| Uuid::parse_str(&id).ok()))
}

fn push_unique(mentions: &mut Vec<Mention>, member_id: Uuid, member_type: MemberType) {
    if mentions
        .iter()
        .any(|m| m.member_type == member_type && m.member_id == member_id)
    {
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
) -> Result<Option<Uuid>, sqlx::Error> {
    let token = token.trim();
    Ok(sqlx::query(
        "SELECT ba.bot_id
         FROM channel_memberships cm
         JOIN bot_accounts ba ON ba.bot_id = cm.member_id
         WHERE cm.channel_id = $1
           AND cm.member_type = 'bot'
           AND (ba.username = $2 OR ba.display_name = $2)
         LIMIT 1",
    )
    .bind(channel_id.to_string())
    .bind(token)
    .fetch_optional(db)
    .await?
    .and_then(|row| row.try_get::<String, _>("bot_id").ok())
    .and_then(|id| Uuid::parse_str(&id).ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_tokens_reads_only_flat_member_tokens() {
        let bot_id = Uuid::parse_str("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").unwrap();
        let user_id = Uuid::parse_str("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb").unwrap();
        let mentions = scan_tokens(&format!(
            "hello <@bot:{bot_id}> and <@user:{user_id}> plus @bare and <#file:ignored>"
        ));

        assert_eq!(
            mentions,
            vec![
                Mention {
                    member_id: bot_id,
                    member_type: MemberType::Bot,
                },
                Mention {
                    member_id: user_id,
                    member_type: MemberType::User,
                },
            ]
        );
    }

    #[test]
    fn scan_tokens_deduplicates_repeated_mentions() {
        let bot_id = Uuid::parse_str("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").unwrap();
        let mentions = scan_tokens(&format!("<@bot:{bot_id}> again <@bot:{bot_id}>"));

        assert_eq!(
            mentions,
            vec![Mention {
                member_id: bot_id,
                member_type: MemberType::Bot,
            }]
        );
    }
}

//! Bot@Bot 触发与取消。
//!
//! bot 回复 finalize 后，若回复中含 @bot mention 且 depth < MAX_BOT_REPLY_DEPTH，
//! 则直接 dispatch 下一跳（和用户消息触发 bot 完全一致，无链跟踪）。
//! 取消接口（cancel / resolve_chain_id_for_message）保留供已有 cancel-chain API 使用。
use std::sync::Arc;

use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    domain::{
        mentions::{MemberType, Mention},
        sessions,
    },
    gateway::{
        dispatcher::{self, DispatchParams},
        realtime::fanout::Fanout,
        registry::BotLocator,
        stream::StreamRegistry,
    },
};

/// bot@bot 触发的最大深度，超出后静默停止。
pub const MAX_BOT_REPLY_DEPTH: i32 = 5;

/// 发起方 bot 在事件权限模型里的 subject 角色。owner 可在 `bot_event_access`
/// 里对 `role=bot`（所有 bot 发起方）或对某个具体 bot（`user=<botId>` 维度）
/// 写 deny，从而关闭 / 收紧 bot@bot；无规则时默认放行（与历史行为一致）。
const BOT_INITIATOR_ROLE: &str = "bot";

/// bot 消息（回复 finalize 或主动 send）落库后，触发消息里的 @bot mention，
/// depth+1 后 dispatch。三重防护：
/// - **深度上限**（[`MAX_BOT_REPLY_DEPTH`]）：`current_depth` 到顶后静默停止，防无限链。
/// - **自 @ 过滤**：作者 bot（`author_bot_id`）即使 @ 了自己也不会再触发自身。
/// - **INITIATE 门禁**：目标 bot 可按“发起方 bot”拒绝被触发（`bot_event_policy`，默认放行）。
#[allow(clippy::too_many_arguments)]
pub async fn trigger_bot_replies(
    db: &PgPool,
    fanout: &Arc<dyn Fanout>,
    stream_registry: &StreamRegistry,
    bot_locator: &Arc<dyn BotLocator>,
    channel_id: Uuid,
    reply_msg_id: Uuid,
    reply_seq: i64,
    current_depth: i32,
    author_bot_id: Uuid,
    mentions: &[Mention],
    chain_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    // 深度上限：到顶后不再触发下一跳（调用方无需自己 guard）。
    if current_depth >= MAX_BOT_REPLY_DEPTH {
        return Ok(());
    }

    // 权威派发闸门（§8）：整条链一旦被用户 ⏹ 取消，后续所有跳都不再启动——
    // 即便取消广播漏掉了某个离线 bot，这里也拦得住（no placeholder, no dispatch）。
    if let Some(cid) = chain_id {
        if !crate::domain::task_chains::is_active(db, cid).await {
            tracing::info!(
                chain_id = %cid,
                channel_id = %channel_id,
                "bot@bot chain not active; dropping downstream hops (dispatch gate)"
            );
            return Ok(());
        }
    }

    // 自 @ 过滤：作者 bot 不会被自己消息里的 @ 再次唤醒。
    let bots = mentioned_bots(mentions, author_bot_id);
    if bots.is_empty() {
        return Ok(());
    }
    // readonly 角色的 bot 不派发（同 create_message 的过滤，见 messages.rs）。
    let bots = crate::domain::messages::filter_writable_bots(db, channel_id, bots).await;

    let next_depth = current_depth.saturating_add(1);

    // Shared across all bots triggered by this reply so identical trigger
    // attachments / pinned files are fetched from S3 once, not once per bot.
    let media_cache = dispatcher::MediaCache::default();
    for bot_id in bots {
        // Per-channel dispatch budget. The proactive `send` / `post_message`
        // paths reset `current_depth` to 0 (they carry no task depth), so the
        // MAX_BOT_REPLY_DEPTH cap alone can't stop a proactive-send ping-pong;
        // and a single group `@all`/`@bots` can fan out to every bot at once.
        // This budget bounds both: a burst passes, sustained loops throttle and
        // log. Checked per target so one over-budget channel can't starve others.
        if !crate::infra::ratelimit::bot_dispatch_limiter().try_hit(&channel_id.to_string()) {
            tracing::warn!(
                channel_id = %channel_id,
                initiator_bot = %author_bot_id,
                "bot@bot dispatch budget exceeded for this channel; skipping remaining triggers this window (loop guard / @all fan-out cap)"
            );
            break;
        }

        // INITIATE 门禁：目标 bot(bot_id) 是否允许被“发起方 bot”(author_bot_id) 触发？
        // 复用事件权限中枢——发起方视为 role="bot" 的 subject，其 bot_id 落在 user 维度，
        // 便于按“某个具体 bot”或“所有 bot”授权/拒绝。默认放行；规则出错时 fail-open。
        let may_prompt = crate::domain::acp_policy::allows(
            db,
            &bot_id.to_string(),
            &channel_id.to_string(),
            &author_bot_id.to_string(),
            BOT_INITIATOR_ROLE,
            "session/prompt",
            crate::domain::bot_event_policy::Capability::Initiate,
        )
        .await
        .unwrap_or(true);
        if !may_prompt {
            tracing::info!(
                target_bot = %bot_id,
                initiator_bot = %author_bot_id,
                channel_id = %channel_id,
                "bot@bot INITIATE denied by bot_event_policy; message posted, target not triggered"
            );
            continue;
        }

        // Per-channel session (see messages.rs): the primary BINDING is
        // authoritative (a promoted session keeps its own key); fall back to the
        // scope-derived deterministic key when no live primary is bound.
        let (provider_session_key, resolved_session_id) =
            match sessions::resolve_primary_session(db, bot_id, &channel_id.to_string())
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
                        provider_session_key_for_bot_channel(channel_id, bot_id);
                    let provider_account_id = resolve_provider_account_id_for_bot(db, bot_id)
                        .await?
                        .unwrap_or_else(|| bot_id.to_string());
                    let session = sessions::acquire_scope_session(
                        db,
                        bot_id,
                        &provider_account_id,
                        &provider_session_key,
                        sessions::SESSION_SCOPE_CHANNEL,
                        &channel_id.to_string(),
                        None,
                        "primary",
                    )
                    .await;

                    if let Err(e) = &session {
                        tracing::warn!(
                            bot_id = %bot_id,
                            channel_id = %channel_id,
                            err = %e,
                            "session acquire failed for bot reply trigger"
                        );
                    }
                    (provider_session_key, session.ok().map(|s| s.session_id))
                }
            };

        if let dispatcher::DispatchResult::DbError(e) = dispatcher::dispatch(
            db,
            fanout,
            stream_registry,
            bot_locator,
            DispatchParams {
                trigger_msg_id: reply_msg_id,
                trigger_seq: reply_seq,
                bot_id,
                channel_id,
                depth: next_depth,
                provider_session_key,
                session_id: resolved_session_id,
                // Every hop inherits the cascade's chain_id, so the whole thing is
                // cancelable as one unit and the gate above blocks it once cancelled.
                chain_id: chain_id.map(ToString::to_string),
            },
            &media_cache,
        )
        .await
        {
            tracing::warn!(bot_id = %bot_id, err = e, "bot reply dispatch failed");
        }
    }

    Ok(())
}

/// 消息里被 @ 的 bot 成员，排除作者本身（自 @ 过滤）。
fn mentioned_bots(mentions: &[Mention], exclude_bot_id: Uuid) -> Vec<Uuid> {
    mentions
        .iter()
        .filter(|mention| mention.member_type == MemberType::Bot)
        .map(|mention| mention.member_id)
        .filter(|&id| id != exclude_bot_id)
        .collect()
}

fn provider_session_key_for_bot_channel(channel_id: Uuid, bot_id: Uuid) -> String {
    format!("cheers:channel:{channel_id}:bot:{bot_id}")
}

async fn resolve_provider_account_id_for_bot(
    db: &PgPool,
    bot_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    let Some(row) = sqlx::query("SELECT binding_config FROM bot_accounts WHERE bot_id = $1")
        .bind(bot_id.to_string())
        .fetch_optional(db)
        .await?
    else {
        return Ok(None);
    };

    let binding_config = row
        .try_get::<Option<serde_json::Value>, _>("binding_config")?
        .unwrap_or(serde_json::Value::Null);

    Ok(resolve_provider_account_id_from_binding_config(
        &binding_config,
    ))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn bot(id: Uuid) -> Mention {
        Mention {
            member_id: id,
            member_type: MemberType::Bot,
        }
    }
    fn user(id: Uuid) -> Mention {
        Mention {
            member_id: id,
            member_type: MemberType::User,
        }
    }

    #[test]
    fn mentioned_bots_excludes_author_self_mention() {
        let author = Uuid::new_v4();
        let other = Uuid::new_v4();
        // author @'d itself and another bot → only the other bot is triggered.
        let out = mentioned_bots(&[bot(author), bot(other)], author);
        assert_eq!(out, vec![other]);
    }

    #[test]
    fn mentioned_bots_keeps_others_and_drops_users() {
        let author = Uuid::new_v4();
        let other = Uuid::new_v4();
        let human = Uuid::new_v4();
        // users are never triggered; a non-author bot is kept.
        let out = mentioned_bots(&[user(human), bot(other)], author);
        assert_eq!(out, vec![other]);
    }

    #[test]
    fn mentioned_bots_pure_self_mention_is_empty() {
        let author = Uuid::new_v4();
        // author @'d only itself → nothing to trigger (no self-loop).
        assert!(mentioned_bots(&[bot(author)], author).is_empty());
    }
}

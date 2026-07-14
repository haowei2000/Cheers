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

/// bot 消息（回复 finalize 或主动 send）落库后，触发消息里的 @bot mention，
/// depth+1 后 dispatch。三重防护：
/// - **深度上限**（[`MAX_BOT_REPLY_DEPTH`]）：`current_depth` 到顶后静默停止，防无限链。
/// - **自 @ 过滤**：作者 bot（`author_bot_id`）即使 @ 了自己也不会再触发自身。
/// - **DISPATCH 门禁**：目标 bot 可按“发起方 bot”拒绝被指挥（`bot_event_policy` 的
///   `dispatch` 能力位，subject=发起方 bot；默认放行，fail-closed，每次决定留审计。
///   见 docs/design/BOT_DISPATCH.md）。
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

        // DISPATCH 门禁：目标 bot(bot_id) 是否允许被“发起方 bot”(author_bot_id) 指挥？
        // 发起方是一等的 bot subject（subject_kind='bot'），过 dispatch 能力位。
        // 默认放行；规则库读不出时 fail-closed 拒绝；每次决定（放行/拒绝）都留审计。
        let decision = crate::domain::bot_event_policy::resolve_dispatch_decision(
            db,
            &bot_id.to_string(),
            &channel_id.to_string(),
            &author_bot_id.to_string(),
        )
        .await;
        record_dispatch_audit(
            db,
            author_bot_id,
            bot_id,
            channel_id,
            chain_id,
            next_depth,
            &decision,
        )
        .await;
        if !decision.allow {
            tracing::info!(
                target_bot = %bot_id,
                initiator_bot = %author_bot_id,
                channel_id = %channel_id,
                reason = decision.reason,
                "bot@bot dispatch denied by grant matrix; message posted, target not triggered"
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

/// Append one dispatch-decision row (allow *and* deny) to `acp_event_log` — the
/// permanent trail behind bot@bot dispatch (docs/design/BOT_DISPATCH.md). Reuses
/// the generic ACP-event substrate: `name='dispatch'`, `home='cheers'`, and a
/// payload naming the initiator, target, decision, and reason. Best-effort — a
/// failed audit write must not disrupt the live turn (it only warns).
async fn record_dispatch_audit(
    db: &PgPool,
    initiator_bot_id: Uuid,
    target_bot_id: Uuid,
    channel_id: Uuid,
    chain_id: Option<&str>,
    depth: i32,
    decision: &crate::domain::bot_event_policy::DispatchDecision,
) {
    let payload = serde_json::json!({
        "initiator_bot_id": initiator_bot_id.to_string(),
        "target_bot_id": target_bot_id.to_string(),
        "channel_id": channel_id.to_string(),
        "chain_id": chain_id,
        "depth": depth,
        "decision": if decision.allow { "allow" } else { "deny" },
        "reason": decision.reason,
    });
    if let Err(err) = sqlx::query(
        "INSERT INTO acp_event_log (id, bot_id, channel_id, session_id, name, home, payload)
         VALUES ($1, $2, $3, NULL, 'dispatch', 'cheers', $4::jsonb)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(target_bot_id.to_string())
    .bind(channel_id.to_string())
    .bind(payload.to_string())
    .execute(db)
    .await
    {
        tracing::warn!(
            target_bot = %target_bot_id,
            initiator_bot = %initiator_bot_id,
            %err,
            "dispatch audit write failed"
        );
    }
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

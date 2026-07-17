//! 频道 presence（在线名单）广播 —— 人机统一。
//!
//! 在线的定义按成员类型分：
//! - 用户：有订阅本频道的活跃浏览器 WS 连接（fanout 的 conn 表）。
//! - bot：connector 的 control + data WS 均在线（BotLocator）。
//!
//! presence 是非终态帧，队列满可丢弃——任何一次变更都会再发一次全量名单。
//! 触发点：浏览器订阅/退订/断线（ws/browser.rs）、bot 桥接上线/下线
//! （ws/agent_bridge.rs）、频道成员增删（api/channels.rs、resource 层 leave）。

use serde_json::json;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::{
    app_state::AppState,
    gateway::{realtime::frame::WireFrame, registry::BotLocator},
};

/// 每频道 bot 成员名单（DB channel_memberships 查询结果）的进程内短 TTL 缓存。
///
/// 成员名单是慢变量，而在线与否由内存 registry（BotLocator）实时判定。连接抖动风暴下
/// broadcast_presence 会被高频调用，缓存把 DB 查询从 O(事件) 降到 O(去重频道/TTL 窗口)，
/// 同时 online/offline 信号仍逐次实时计算，presence 不会因缓存而变陈旧。
const BOT_ROSTER_TTL: Duration = Duration::from_secs(2);

struct RosterEntry {
    members: Vec<String>,
    fetched_at: Instant,
}

fn roster_cache() -> &'static Mutex<HashMap<Uuid, RosterEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<Uuid, RosterEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取频道的 bot 成员名单：命中未过期缓存直接返回，否则查 DB 并刷新缓存。
/// 查询失败时与原行为一致——返回空且不写入缓存（下次调用重试）。
async fn channel_bot_members(db: &PgPool, channel_id: Uuid) -> Vec<String> {
    {
        let cache = roster_cache().lock().unwrap();
        if let Some(entry) = cache.get(&channel_id) {
            if entry.fetched_at.elapsed() < BOT_ROSTER_TTL {
                return entry.members.clone();
            }
        }
    }
    let fetched: Result<Vec<String>, _> = sqlx::query_scalar(
        "SELECT member_id FROM channel_memberships
         WHERE channel_id = $1 AND member_type = 'bot'",
    )
    .bind(channel_id.to_string())
    .fetch_all(db)
    .await;
    match fetched {
        Ok(member_ids) => {
            let mut cache = roster_cache().lock().unwrap();
            cache.insert(
                channel_id,
                RosterEntry {
                    members: member_ids.clone(),
                    fetched_at: Instant::now(),
                },
            );
            member_ids
        }
        Err(_) => Vec::new(),
    }
}

/// 计算并广播一个频道的全量在线名单（用户 + bot）。
pub async fn broadcast_presence(state: &AppState, channel_id: Uuid) {
    let online_user_ids = state.fanout.online_users(channel_id);
    let online_bot_ids = channel_online_bots(&state.db, &state.bot_locator, channel_id).await;
    let count = online_user_ids.len() + online_bot_ids.len();
    // 工作台在看焦点：谁正在看哪个 bot 的工作区（可含路径）。随全量 presence 下发。
    let focus: Vec<_> = state
        .fanout
        .channel_focus(channel_id)
        .into_iter()
        .map(
            |(user_id, bot_id, path)| json!({ "user_id": user_id, "bot_id": bot_id, "path": path }),
        )
        .collect();
    let frame = WireFrame::channel(
        channel_id,
        "presence",
        json!({
            "channel_id": channel_id,
            "online_user_ids": online_user_ids,
            "online_bot_ids": online_bot_ids,
            "count": count,
            "focus": focus,
        }),
    );
    state.fanout.broadcast_channel(channel_id, frame).await;
}

/// 频道 bot 成员里当前在线的（connector 双 WS 在线）。
pub async fn channel_online_bots(
    db: &PgPool,
    bot_locator: &Arc<dyn BotLocator>,
    channel_id: Uuid,
) -> Vec<String> {
    // 成员名单走短 TTL 缓存（慢变量）；在线状态每次实时判定（快变量）。
    let member_ids = channel_bot_members(db, channel_id).await;

    let mut online = Vec::new();
    for id in member_ids {
        if let Ok(uuid) = Uuid::parse_str(&id) {
            if bot_locator.is_online(uuid).await {
                online.push(id);
            }
        }
    }
    online
}

/// bot 桥接上线/下线时：向它所属的每个频道广播一次 presence。
pub async fn broadcast_bot_presence(state: &AppState, bot_id: Uuid) {
    let channel_ids: Vec<String> = sqlx::query_scalar(
        "SELECT channel_id FROM channel_memberships
         WHERE member_id = $1 AND member_type = 'bot'",
    )
    .bind(bot_id.to_string())
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    for channel_id in channel_ids {
        if let Ok(cid) = Uuid::parse_str(&channel_id) {
            broadcast_presence(state, cid).await;
        }
    }
}

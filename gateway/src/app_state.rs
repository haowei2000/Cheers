use std::sync::Arc;

use sqlx::PgPool;

use crate::{
    acp_bridge::{
        registry::{BotLocator, InProcessBotLocator},
        stream::StreamRegistry,
    },
    config::Config,
    realtime::{fanout::Fanout, manager::ConnectionManager},
};

/// 所有 axum handler 通过 `State(state): State<AppState>` 拿到这个。
#[derive(Clone)]
pub struct AppState {
    /// sqlx 连接池，所有 DB 操作用这个。
    pub db: PgPool,

    /// 应用配置（只读）。
    pub config: Arc<Config>,

    /// 广播给浏览器连接的 fan-out 实现。
    pub fanout: Arc<dyn Fanout>,

    /// 浏览器 WS 连接管理器（subscribe/unsubscribe + 成员资格缓存）。
    pub conn_manager: Arc<ConnectionManager>,

    /// 【业务层接口】向 bot 派发任务 / 发送数据帧。
    /// - dispatcher、domain 层只用这个，不感知底层实现。
    /// - 单实例：指向同一个 InProcessBotLocator 实例。
    /// - 多实例迁移：换成 RedisOrNatsBotLocator，此字段签名不变，其余代码零改动。
    pub bot_locator: Arc<dyn BotLocator>,

    /// 【WS 连接层接口】管理 bot 的 control/data WS 连接注册。
    /// - 只有 transport/ws/acp_bridge.rs 用这个（bind_control / bind_data）。
    /// - 这些是进程内特有操作，故不进 BotLocator trait。
    /// - 多实例迁移时：删除此字段，WS handler 改为往 Redis 写连接元信息。
    pub bot_registry: Arc<InProcessBotLocator>,

    /// delta/done 回流注册表（msg_id → StreamEntry）。
    pub stream_registry: Arc<StreamRegistry>,
}

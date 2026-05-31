use std::sync::Arc;

use sqlx::PgPool;

use crate::{
    config::Config,
    gateway::{
        realtime::{fanout::Fanout, manager::ConnectionManager},
        registry::{BotLocator, BotRegistry},
        stream::StreamRegistry,
    },
};

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    /// 广播给浏览器连接的 fan-out 实现（可替换：单实例=进程内，多实例=Redis）。
    pub fanout: Arc<dyn Fanout>,
    /// 浏览器 WS 连接管理器（subscribe/unsubscribe + 成员资格缓存）。
    pub conn_manager: Arc<ConnectionManager>,
    /// 向 bot 派发任务 / 发送数据帧（BotLocator trait，可替换实现）。
    pub bot_locator: Arc<dyn BotLocator>,
    /// 管理 bot control/data WS 连接注册（BotRegistry trait）。
    pub bot_registry: Arc<dyn BotRegistry>,
    /// delta/done 回流注册表（msg_id → StreamEntry）。
    pub stream_registry: Arc<StreamRegistry>,
}

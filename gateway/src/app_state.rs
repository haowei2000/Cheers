use std::sync::Arc;

use sqlx::PgPool;

use crate::{
    acp_bridge::registry::BotLocator,
    config::Config,
    realtime::fanout::Fanout,
};

/// 所有 axum handler 通过 `State(state): State<AppState>` 拿到这个。
#[derive(Clone)]
pub struct AppState {
    /// sqlx 连接池，所有 DB 操作用这个。
    pub db: PgPool,

    /// 应用配置（只读）。
    pub config: Arc<Config>,

    /// 广播给浏览器连接的 fan-out 实现。
    /// 本期：InProcessFanout（进程内 DashMap）。
    /// 未来多实例：换成 RedisFanout，只改 main.rs 里的初始化。
    pub fanout: Arc<dyn Fanout>,

    /// 向 bot 派发任务 / 发送数据帧的实现。
    /// 本期：InProcessBotLocator（进程内 DashMap）。
    /// 未来多实例：换成跨实例路由实现。
    pub bot_locator: Arc<dyn BotLocator>,
}

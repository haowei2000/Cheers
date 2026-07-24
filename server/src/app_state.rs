use std::sync::Arc;

use sqlx::PgPool;

use crate::{
    config::Config,
    domain::webauthn::WebauthnService,
    gateway::{
        realtime::{fanout::Fanout, manager::ConnectionManager},
        registry::{BotLocator, BotRegistry},
        stream::StreamRegistry,
        workspace_rpc::WorkspaceRpc,
    },
    infra::web_push::WebPushSender,
};

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    /// Configured WebAuthn relying party; `None` when Passkeys are disabled.
    pub webauthn: Option<Arc<WebauthnService>>,
    /// S3 / RustFS client for gateway-proxied file upload/download.
    pub s3: aws_sdk_s3::Client,
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
    /// 远程工作区 RPC：gateway→connector 的 workspace_req/res 关联表。
    pub workspace_rpc: Arc<WorkspaceRpc>,
    /// Web Push 发送器（VAPID 未配置则为 None，推送整体禁用）。
    pub web_push: Option<Arc<WebPushSender>>,
    /// OS push transport (direct APNs, or the official relay for self-hosted
    /// gateways). None = push unconfigured; in-app WS delivery is unaffected
    /// (docs/arch/MOBILE_APP_DESIGN.md §5).
    pub push: Option<Arc<crate::notify::PushTransport>>,
}

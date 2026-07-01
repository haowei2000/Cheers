use std::env;

/// Browser origins allowed when CORS_ALLOWED_ORIGINS is unset (local dev). This
/// is a fail-closed allowlist — NOT a wildcard — so an unconfigured deployment
/// still rejects arbitrary cross-origin callers. Production must set the env var.
const DEV_DEFAULT_ORIGINS: &[&str] = &[
    "http://localhost",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:30080",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "http://127.0.0.1:30080",
];

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub port: u16,

    // JWT — RS256
    // 私钥：PEM 格式，用于签发 token（Bearer + botToken）
    pub jwt_private_key_pem: String,
    // 公钥：PEM 格式，用于验签
    pub jwt_public_key_pem: String,

    // Redis
    pub redis_url: String,

    // S3 / RustFS
    pub s3_endpoint: String,
    pub s3_bucket: String,
    pub s3_access_key: String,
    pub s3_secret_key: String,
    pub s3_region: String,
    pub cors_allowed_origins: Option<String>,

    /// Public WS base the connector dials to reach this gateway's agent-bridge,
    /// e.g. `ws://localhost:30080` (via the frontend proxy for local kind) or
    /// `wss://cheers.example.com` for prod. Surfaced by GET /ops/connector-discovery
    /// so onboarding-generated configs point somewhere actually reachable.
    pub connector_public_base: Option<String>,

    /// Base URL of the Gotenberg document-conversion service (e.g.
    /// `http://cheers-gotenberg:3000`). When unset, office→PDF preview conversion
    /// is disabled and the conversion worker is not started.
    pub gotenberg_url: Option<String>,
    /// How often the office→PDF conversion worker polls for pending files
    /// (default 20; 0 runs only the startup pass).
    pub conversion_poll_interval_secs: u64,

    // SMTP（可选，不配置则不发邮件）
    pub smtp_host: Option<String>,
    pub smtp_port: u16,
    pub smtp_username: Option<String>,
    pub smtp_password: Option<String>,

    // 孤儿占位回收器（流程 8 缺口）
    /// 占位早于该秒数且无存活流时才回收（默认 900 = 15 分钟，给 bot 重启重连留时间）。
    pub orphan_reclaim_threshold_secs: u64,
    /// 周期扫描间隔秒数（默认 60；设为 0 则只在启动时扫一次）。
    pub orphan_reclaim_interval_secs: u64,

    // 审批卡 server 端兜底 TTL 扫描
    /// 待审批卡片超过该秒数仍未解决则扫为 expired（默认 1800 = 30 分钟）。
    /// 是连接器自身权限超时之上的兜底——正常情况下连接器先发 permission_cancel，
    /// 本扫描只兜底「连接器进程在超时前就死掉」导致卡片永久 pending 的情况。
    pub approval_card_ttl_secs: u64,
    /// 审批卡扫描间隔秒数（默认 120；设为 0 则只在启动时扫一次）。
    pub approval_sweep_interval_secs: u64,
}

impl Config {
    /// 从环境变量读取配置，缺少必填项时 panic（启动时快速失败）。
    pub fn from_env() -> Self {
        dotenvy::dotenv().ok();

        Self {
            database_url: require("DATABASE_URL"),
            port: env::var("PORT")
                .unwrap_or_else(|_| "8000".into())
                .parse()
                .expect("PORT must be a number"),

            jwt_private_key_pem: require("JWT_PRIVATE_KEY"),
            jwt_public_key_pem: require("JWT_PUBLIC_KEY"),

            redis_url: env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".into()),

            s3_endpoint: require_any(&["S3_ENDPOINT", "STORAGE_S3_ENDPOINT"]),
            s3_bucket: env::var("S3_BUCKET")
                .or_else(|_| env::var("STORAGE_S3_BUCKET"))
                .unwrap_or_else(|_| "cheers".into()),
            s3_access_key: require_any(&["S3_ACCESS_KEY", "STORAGE_S3_ACCESS_KEY"]),
            s3_secret_key: require_any(&["S3_SECRET_KEY", "STORAGE_S3_SECRET_KEY"]),
            s3_region: env::var("S3_REGION")
                .or_else(|_| env::var("STORAGE_S3_REGION"))
                .unwrap_or_else(|_| "us-east-1".into()),
            cors_allowed_origins: env::var("CORS_ALLOWED_ORIGINS")
                .ok()
                .filter(|v| !v.trim().is_empty()),
            connector_public_base: env::var("CHEERS_CONNECTOR_PUBLIC_BASE")
                .ok()
                .filter(|v| !v.trim().is_empty()),

            gotenberg_url: env::var("GOTENBERG_URL")
                .ok()
                .filter(|v| !v.trim().is_empty()),
            conversion_poll_interval_secs: env::var("CONVERSION_POLL_INTERVAL_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(20),

            smtp_host: env::var("SMTP_HOST").ok(),
            smtp_port: env::var("SMTP_PORT")
                .unwrap_or_else(|_| "587".into())
                .parse()
                .unwrap_or(587),
            smtp_username: env::var("SMTP_USERNAME").ok(),
            smtp_password: env::var("SMTP_PASSWORD").ok(),

            orphan_reclaim_threshold_secs: env::var("ORPHAN_RECLAIM_THRESHOLD_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(900),
            orphan_reclaim_interval_secs: env::var("ORPHAN_RECLAIM_INTERVAL_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(60),

            approval_card_ttl_secs: env::var("APPROVAL_CARD_TTL_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1800),
            approval_sweep_interval_secs: env::var("APPROVAL_SWEEP_INTERVAL_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(120),
        }
    }

    /// Browser origins allowed for both CORS and the WebSocket `Origin` check.
    /// Falls back to the localhost dev allowlist (never wildcard) when
    /// CORS_ALLOWED_ORIGINS is unset.
    pub fn allowed_origins(&self) -> Vec<String> {
        match self.cors_allowed_origins.as_deref() {
            Some(s) if !s.trim().is_empty() => s
                .split(',')
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
                .collect(),
            _ => DEV_DEFAULT_ORIGINS.iter().map(|s| s.to_string()).collect(),
        }
    }
}

fn require(key: &str) -> String {
    env::var(key).unwrap_or_else(|_| panic!("missing required env var: {key}"))
}

fn require_any(keys: &[&str]) -> String {
    for &k in keys {
        if let Ok(v) = env::var(k) {
            if !v.trim().is_empty() {
                return v;
            }
        }
    }

    panic!("missing required env var, set one of: {}", keys.join(", "));
}

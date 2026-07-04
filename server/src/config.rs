use std::env;

use jsonwebtoken::{DecodingKey, EncodingKey};

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

/// RS256 keypair, parsed **once at startup** (fail-fast) and reused for every
/// sign/verify instead of re-parsing the PEM on each call. A missing or invalid
/// key therefore aborts the process before the listener binds, instead of
/// surfacing as an unexplained 500 at first login.
#[derive(Clone)]
pub struct JwtKeys {
    /// Signs tokens (login, file-preview grants). From JWT_PRIVATE_KEY.
    pub encoding: EncodingKey,
    /// Verifies tokens (HTTP middleware + WS auth). From JWT_PUBLIC_KEY.
    pub decoding: DecodingKey,
}

impl std::fmt::Debug for JwtKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("JwtKeys(<redacted>)")
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub port: u16,

    // JWT — RS256
    // 私钥 PEM 原文：仅用于派生 secret-store 主密钥（infra::crypto）；签发/验签
    // 一律走下面已解析好的 `jwt`。
    pub jwt_private_key_pem: String,
    /// Parsed RS256 keypair (see [`JwtKeys`]).
    pub jwt: JwtKeys,

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

    /// Optional dedicated master-key material for encrypting admin-entered secrets
    /// at rest (system_settings). When unset, the key is derived from the JWT
    /// private key — set this to survive JWT key rotation without re-entering secrets.
    pub secret_store_key: Option<String>,

    // SMTP（可选，不配置则不发邮件）
    pub smtp_host: Option<String>,
    pub smtp_port: u16,
    pub smtp_username: Option<String>,
    pub smtp_password: Option<String>,

    /// Whether public self-service sign-up (`POST /auth/register`) is enabled.
    /// Default true; set `OPEN_REGISTRATION=0/false` for invite/admin-only instances.
    pub open_registration: bool,

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

        // Fail fast on the JWT keypair: read AND parse both PEMs here, before
        // anything binds the listener, so `helm install` / `docker compose up`
        // with blank or garbage keys dies with an actionable message instead of
        // "succeeding" and then 500ing at first login.
        let jwt_private_key_pem = require("JWT_PRIVATE_KEY");
        let jwt_public_key_pem = require("JWT_PUBLIC_KEY");
        let jwt = JwtKeys {
            encoding: EncodingKey::from_rsa_pem(jwt_private_key_pem.as_bytes()).unwrap_or_else(
                |e| {
                    panic!("JWT_PRIVATE_KEY is missing or not a valid RSA private-key PEM ({e}) — see docs/help/deployment.md")
                },
            ),
            decoding: DecodingKey::from_rsa_pem(jwt_public_key_pem.as_bytes()).unwrap_or_else(
                |e| {
                    panic!("JWT_PUBLIC_KEY is missing or not a valid RSA public-key PEM ({e}) — see docs/help/deployment.md")
                },
            ),
        };

        Self {
            database_url: require("DATABASE_URL"),
            port: env::var("PORT")
                .unwrap_or_else(|_| "8000".into())
                .parse()
                .expect("PORT must be a number"),

            jwt_private_key_pem,
            jwt,

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

            secret_store_key: env::var("SECRET_STORE_KEY")
                .ok()
                .filter(|v| !v.trim().is_empty()),

            smtp_host: env::var("SMTP_HOST").ok(),
            smtp_port: env::var("SMTP_PORT")
                .unwrap_or_else(|_| "587".into())
                .parse()
                .unwrap_or(587),
            smtp_username: env::var("SMTP_USERNAME").ok(),
            smtp_password: env::var("SMTP_PASSWORD").ok(),

            open_registration: env::var("OPEN_REGISTRATION")
                .ok()
                .map(|v| {
                    !matches!(
                        v.trim().to_ascii_lowercase().as_str(),
                        "0" | "false" | "no" | "off"
                    )
                })
                .unwrap_or(true),

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

/// Read a required env var. Empty/whitespace-only values count as MISSING so a
/// templated-but-blank value (e.g. compose's `${JWT_PRIVATE_KEY:-}` or a Helm
/// secret defaulted to "") fails startup loudly instead of producing a gateway
/// that boots but cannot mint or verify tokens.
fn require(key: &str) -> String {
    match env::var(key) {
        Ok(v) if !v.trim().is_empty() => v,
        _ => panic!("required env var {key} is missing or empty — see docs/help/deployment.md"),
    }
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

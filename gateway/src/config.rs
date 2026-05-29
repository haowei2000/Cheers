use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub port: u16,

    // JWT — RS256
    // 私钥：PEM 格式，用于签发 token（Bearer + botToken）
    pub jwt_private_key_pem: String,
    // 公钥：PEM 格式，用于验签
    pub jwt_public_key_pem: String,
    // 迁移窗口期间同时接受旧 HS256 token 的密钥（可选）
    pub jwt_legacy_hs256_secret: Option<String>,

    // Redis
    pub redis_url: String,

    // S3 / RustFS
    pub s3_endpoint: String,
    pub s3_bucket: String,
    pub s3_access_key: String,
    pub s3_secret_key: String,

    // SMTP（可选，不配置则不发邮件）
    pub smtp_host: Option<String>,
    pub smtp_port: u16,
    pub smtp_username: Option<String>,
    pub smtp_password: Option<String>,
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
            jwt_legacy_hs256_secret: env::var("JWT_SECRET_KEY").ok(),

            redis_url: env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".into()),

        s3_endpoint: require("S3_ENDPOINT"),
            s3_bucket: env::var("S3_BUCKET").unwrap_or_else(|_| "agentnexus".into()),
            s3_access_key: require("S3_ACCESS_KEY"),
            s3_secret_key: require("S3_SECRET_KEY"),

            smtp_host: env::var("SMTP_HOST").ok(),
            smtp_port: env::var("SMTP_PORT")
                .unwrap_or_else(|_| "587".into())
                .parse()
                .unwrap_or(587),
            smtp_username: env::var("SMTP_USERNAME").ok(),
            smtp_password: env::var("SMTP_PASSWORD").ok(),
        }
    }
}

fn require(key: &str) -> String {
    env::var(key).unwrap_or_else(|_| panic!("missing required env var: {key}"))
}

"""应用配置，从环境变量加载。"""
from pathlib import Path

from pydantic_settings import BaseSettings

# backend 根目录（app/config.py -> app -> backend）
_BACKEND_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    """全局配置."""

    # 主业务数据库（PostgreSQL）
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/agentnexus"

    # Context Store 数据库（四层记忆；默认同主库）
    context_db_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/agentnexus"

    # Redis
    redis_url: str = "redis://localhost:6379/0"

    # OpenClaw Hook 集成（/hooks/agent）
    openclaw_hook_token: str = ""  # Authorization: Bearer <token>，留空则 hook 端点不校验（需在 .env 中配置）
    openclaw_agent_id: str = "main"
    openclaw_session_prefix: str = "nexus:"

    # 数据目录（相对项目根或绝对路径）
    data_dir: str = "data"

    # S3-compatible object storage (RustFS / MinIO / AWS S3 / Cloudflare R2)
    storage_backend: str = "none"
    storage_s3_endpoint: str = ""
    storage_s3_public_endpoint: str = ""
    storage_s3_region: str = "us-east-1"
    storage_s3_access_key: str = ""
    storage_s3_secret_key: str = ""
    storage_s3_bucket: str = ""
    storage_s3_force_path_style: bool = True
    storage_s3_auto_create_bucket: bool = True
    storage_s3_verify_ssl: bool = True
    storage_presign_expires_seconds: int = 900
    file_upload_max_bytes: int = 25 * 1024 * 1024
    file_upload_allowed_types: str = (
        "application/pdf,"
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document,"
        "text/plain,"
        "image/png,image/jpeg,image/webp,image/gif"
    )
    file_parse_max_chars: int = 12000

    # JWT 认证
    jwt_secret_key: str = ""  # 留空则启动时自动生成（非持久化），建议在 .env 中配置
    jwt_algorithm: str = "HS256"
    jwt_access_token_expire_minutes: int = 1440  # 24 小时

    # API Key 加密存储（Fernet 对称加密）
    api_key_encryption_key: str = ""  # Base64 Fernet 密钥；留空则自动生成并持久化到 data/.encryption_key

    # 调试
    debug: bool = False

    # 日志目录（相对项目根或绝对路径）；留空则仅控制台
    log_dir: str = "data/logs"
    # 单日志文件最大字节，0 表示不轮转
    log_max_bytes: int = 5 * 1024 * 1024  # 5MB
    log_backup_count: int = 3

    # 引导 Bot 使用的 LLM（可选；不配置则用关键词匹配；默认连本地 Ollama）
    guide_llm_base_url: str = ""
    guide_llm_model: str = ""
    guide_llm_api_key: str = ""
    guide_llm_temperature: float = 0.7
    guide_llm_max_tokens: int = 1000
    llm_localhost_alias: str = ""

    # 系统 LLM（RECENT 压缩、文件摘要等；不配置则简单截断）
    system_llm_api_key: str = ""
    system_llm_base_url: str = ""  # OpenAI 兼容
    system_llm_model: str = ""

    # 文生图（DashScope 原生 API）
    image_gen_base_url: str = "https://dashscope.aliyuncs.com"
    image_gen_api_key: str = ""
    image_gen_default_model: str = "qwen-image-2.0-pro"

    # 邮件 SMTP 配置（留空则仅打印验证码到日志，适合开发环境）
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = ""          # 发件人地址，留空则用 smtp_username
    smtp_use_tls: bool = True    # True=STARTTLS(587)；False=SSL(465) 时建议改 smtp_port=465
    smtp_ssl: bool = False       # True 时用 SSL 直连（465端口）

    # 种子数据：初始管理员账号
    admin_username: str = "admin"
    admin_password: str = "admin#Nexus2024"
    admin_display_name: str = "系统管理员"

    model_config = {
        "env_file": [str(_BACKEND_ROOT.parent / ".env"), str(_BACKEND_ROOT / ".env")],
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


def get_data_dir(base: Path) -> Path:
    """解析 data 目录路径."""
    p = Path(settings.data_dir)
    if not p.is_absolute():
        p = base / p
    return p


settings = Settings()

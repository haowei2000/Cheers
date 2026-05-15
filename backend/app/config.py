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

    # 高并发控制
    orchestrator_queue_backend: str = "redis"  # redis | memory
    orchestrator_worker_concurrency: int = 4
    orchestrator_bot_concurrency_per_message: int = 3
    bot_pipeline_redis_read_count: int = 8
    bot_event_queue_backend: str = ""  # "" = follow orchestrator_queue_backend; redis | memory
    bot_event_worker_concurrency: int = 4
    bot_event_redis_read_count: int = 8
    realtime_broker_backend: str = "redis"  # redis | memory
    ws_outbound_queue_size: int = 256
    ws_broadcast_enqueue_concurrency: int = 128
    ws_send_timeout_seconds: float = 5.0
    stream_delta_flush_interval_seconds: float = 0.08
    stream_delta_flush_chars: int = 512
    unread_fanout_concurrency: int = 64
    recent_debounce_seconds: float = 5.0

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
    # 文件保存时间：默认 90 天（约 3 个月）；<=0 表示不过期。
    file_retention_days: int = 90
    file_retention_cleanup_interval_seconds: int = 24 * 60 * 60
    file_upload_allowed_types: str = (
        "application/pdf,"
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document,"
        "text/plain,"
        "image/png,image/jpeg,image/webp,image/gif"
    )
    file_parse_max_chars: int = 12000
    avatar_upload_max_bytes: int = 2 * 1024 * 1024
    avatar_upload_allowed_types: str = "image/png,image/jpeg,image/webp,image/gif"

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

    # Helper Bot 使用的 LLM（可选；不配置则用关键词匹配）
    helper_llm_base_url: str = ""
    helper_llm_model: str = ""
    helper_llm_api_key: str = ""
    helper_llm_temperature: float = 0.7
    helper_llm_max_tokens: int = 1000
    llm_localhost_alias: str = ""

    # 系统 LLM（RECENT 压缩、文件摘要等；不配置则简单截断）
    system_llm_api_key: str = ""
    system_llm_base_url: str = ""  # OpenAI 兼容
    system_llm_model: str = ""

    # 后端记忆分页与近期上下文（不影响前端消息列表分页）
    memory_history_page_max_chars: int = 50000
    memory_recent_direct_message_count: int = 30
    memory_recent_summary_max_chars: int = 1500

    # 邮件 SMTP 配置（留空则仅打印验证码到日志，适合开发环境）
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = ""          # 发件人地址，留空则用 smtp_username
    smtp_use_tls: bool = True    # True=STARTTLS(587)；False=SSL(465) 时建议改 smtp_port=465
    smtp_ssl: bool = False       # True 时用 SSL 直连（465端口）


    # Web 搜索引擎：bing_cn（必应国内版）/ baidu（百度）/ duckduckgo
    web_search_engine: str = "bing_cn"
    # Web 搜索 / web_fetch 代理（留空则直连）
    web_search_proxy: str = ""

    # CORS 允许的前端 origin 列表（逗号分隔或直接配置为列表）
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    # 日志格式（True = JSON 结构化日志；False = 人类可读文本）
    log_json: bool = False

    # 种子数据：初始管理员账号
    admin_username: str = "admin"
    admin_password: str = "admin#Nexus2024"
    admin_display_name: str = "系统管理员"

    # ===== Agent Bridge =====
    agent_bridge_enabled: bool = True
    agent_bridge_token: str = ""  # 空 = 未配置，bridge 路由返回 503
    # 异步 Bot 前台等待阈值：超时后只把占位消息转成后台 task，不终止 provider 任务。
    agent_bridge_timeout_seconds: int = 600

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


def resolve_data_dir() -> Path:
    """零参数版：以 backend/app/ 为基准解析 data_dir（与历史 adapters 写入位置一致）。"""
    p = Path(settings.data_dir)
    if p.is_absolute():
        return p
    return _BACKEND_ROOT / "app" / p


settings = Settings()

"""Application configuration loaded from environment variables."""
from pathlib import Path

from pydantic_settings import BaseSettings

# Backend root directory (app/config.py -> app -> backend).
_BACKEND_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    """Global configuration."""

    # Main business database (PostgreSQL).
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/agentnexus"

    # Context Store database for memory layers; defaults to the main database.
    context_db_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/agentnexus"

    # Redis
    redis_url: str = "redis://localhost:6379/0"

    # High-concurrency controls.
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

    # Data directory, relative to project root or absolute.
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
    # File retention: default 365 days; <=0 disables expiry.
    file_retention_days: int = 365
    file_retention_cleanup_interval_seconds: int = 24 * 60 * 60
    file_upload_allowed_types: str = (
        "application/pdf,"
        "application/msword,"
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document,"
        "application/vnd.ms-excel,"
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,"
        "application/vnd.ms-powerpoint,"
        "application/vnd.openxmlformats-officedocument.presentationml.presentation,"
        "application/ofd,application/rtf,text/csv,"
        "application/zip,application/vnd.rar,application/x-7z-compressed,"
        "application/x-tar,application/gzip,application/epub+zip,"
        "text/html,text/plain,"
        "image/png,image/jpeg,image/webp,image/gif"
    )
    file_parse_max_chars: int = 12000
    public_base_url: str = "http://localhost"
    kkfileview_enabled: bool = True
    kkfileview_base_url: str = "http://localhost/preview"
    kkfileview_token_ttl_seconds: int = 10 * 60
    avatar_upload_max_bytes: int = 2 * 1024 * 1024
    avatar_upload_allowed_types: str = "image/png,image/jpeg,image/webp,image/gif"

    # JWT authentication.
    jwt_secret_key: str = ""  # Empty means generated at startup and not persisted; prefer setting it in .env.
    jwt_algorithm: str = "HS256"
    jwt_access_token_expire_minutes: int = 1440  # 24 hours

    # API key encrypted storage with Fernet symmetric encryption.
    api_key_encryption_key: str = ""  # Base64 Fernet key; empty means generated and persisted to data/.encryption_key.

    # Debug.
    debug: bool = False

    # Log directory, relative to project root or absolute; empty means console only.
    log_dir: str = "data/logs"
    # Maximum bytes per log file; 0 disables rotation.
    log_max_bytes: int = 5 * 1024 * 1024  # 5MB
    log_backup_count: int = 3

    # LLM used by the Helper Bot; keyword matching is used when unset.
    helper_llm_base_url: str = ""
    helper_llm_model: str = ""
    helper_llm_api_key: str = ""
    helper_llm_temperature: float = 0.7
    helper_llm_max_tokens: int = 1000
    llm_localhost_alias: str = ""

    # System LLM for RECENT compression, file summaries, and similar tasks; simple truncation is used when unset.
    system_llm_api_key: str = ""
    system_llm_base_url: str = ""  # OpenAI-compatible
    system_llm_model: str = ""

    # Backend memory pagination and recent context; does not affect frontend message-list pagination.
    memory_history_page_max_chars: int = 50000
    memory_recent_direct_message_count: int = 30
    memory_recent_summary_max_chars: int = 1500

    # SMTP email settings; when empty, verification codes are only logged for development.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = ""          # Sender address; defaults to smtp_username when empty.
    smtp_use_tls: bool = True    # True=STARTTLS(587); for SSL(465), set False and use smtp_ssl=True.
    smtp_ssl: bool = False       # Use direct SSL, usually on port 465.


    # Web search engine: bing_cn, baidu, or duckduckgo.
    web_search_engine: str = "bing_cn"
    # Proxy for web search and web_fetch; empty means direct connection.
    web_search_proxy: str = ""

    # Allowed frontend origins for CORS, either comma-separated or configured as a list.
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    # Log format; True emits structured JSON and False emits human-readable text.
    log_json: bool = False

    # Seed data: initial administrator account.
    admin_username: str = "admin"
    admin_password: str = "change-me-admin-password"
    admin_display_name: str = "系统管理员"

    # ===== Agent Bridge =====
    agent_bridge_enabled: bool = True
    agent_bridge_token: str = ""  # Empty means bridge routes return 503.
    # Foreground wait threshold for async bots; after timeout, only the placeholder becomes a background task.
    agent_bridge_timeout_seconds: int = 600

    model_config = {
        "env_file": [str(_BACKEND_ROOT.parent / ".env"), str(_BACKEND_ROOT / ".env")],
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


def get_data_dir(base: Path) -> Path:
    """Get data dir."""
    p = Path(settings.data_dir)
    if not p.is_absolute():
        p = base / p
    return p


def resolve_data_dir() -> Path:
    """Resolve data dir."""
    p = Path(settings.data_dir)
    if p.is_absolute():
        return p
    return _BACKEND_ROOT / "app" / p


settings = Settings()

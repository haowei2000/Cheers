"""SkillHub backend configuration."""
from pathlib import Path
from pydantic_settings import BaseSettings

# SkillHub root directory.
_SKILLHUB_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    """SkillHub configuration."""
    host: str = "0.0.0.0"
    port: int = 8002

    # Local skill storage directory.
    skills_local_dir: Path = _SKILLHUB_ROOT / "data" / "skills-local"

    # Local Git repository directory for skills pulled from GitFox.
    skills_repo_dir: Path = _SKILLHUB_ROOT.parent.parent / "skills-repo"

    # GitFox repository configuration loaded from environment variables.
    gitfox_repo_url: str = ""
    gitfox_remote_name: str = "origin"
    gitfox_branch: str = "main"

    # Git sync switch.
    git_sync_enabled: bool = True

    # OpenClaw API Key loaded from environment variables.
    openclaw_api_key: str = ""

    # Maximum upload size in bytes; default 50 MB.
    max_upload_size: int = 50 * 1024 * 1024

    class Config:
        env_file = _SKILLHUB_ROOT / ".env"
        extra = "ignore"


settings = Settings()

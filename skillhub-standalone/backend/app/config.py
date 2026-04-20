"""SkillHub 后端配置"""
from pathlib import Path
from pydantic_settings import BaseSettings

# SkillHub 根目录
_SKILLHUB_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    """SkillHub 配置"""
    host: str = "0.0.0.0"
    port: int = 8002

    # Skill 本地存储目录
    skills_local_dir: Path = _SKILLHUB_ROOT / "data" / "skills-local"

    # Git 本地仓库目录（用于存储从 GitFox 拉取的 Skills）
    skills_repo_dir: Path = _SKILLHUB_ROOT.parent.parent / "skills-repo"

    # GitFox 仓库配置（从环境变量读取，敏感信息不上传到 git）
    gitfox_repo_url: str = ""
    gitfox_remote_name: str = "origin"
    gitfox_branch: str = "main"

    # Git 同步开关
    git_sync_enabled: bool = True

    # OpenClaw API Key（从环境变量读取）
    openclaw_api_key: str = ""

    # 最大上传文件大小（字节），默认 50MB
    max_upload_size: int = 50 * 1024 * 1024

    class Config:
        env_file = _SKILLHUB_ROOT / ".env"
        extra = "ignore"


settings = Settings()

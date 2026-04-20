"""Git 同步模块 - 使用 git fetch + rebase 从 GitFox 拉取最新 Skills"""
import logging
import os
import shutil
import subprocess
from pathlib import Path
from datetime import datetime

from app.config import settings
from app.models import SyncResult
from app.services.manager import clear_cache

logger = logging.getLogger("skillhub.sync")


def _run_git_command(repo_path: Path, *args, env: dict = None) -> tuple[bool, str]:
    """执行 git 命令"""
    try:
        # 准备环境变量
        run_env = os.environ.copy()
        if env:
            run_env.update(env)

        # 设置 Git 凭证存储
        credential_env = {
            "GIT_TERMINAL_PROMPT": "0",
        }
        run_env.update(credential_env)

        result = subprocess.run(
            ["git"] + list(args),
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=120,
            env=run_env
        )
        return result.returncode == 0, result.stdout + result.stderr
    except subprocess.TimeoutExpired:
        return False, "Git command timeout"
    except FileNotFoundError:
        return False, "Git not found"
    except Exception as e:
        return False, str(e)


def _is_git_repo(repo_path: Path) -> bool:
    """检查目录是否为 Git 仓库"""
    return (repo_path / ".git").exists()


def _configure_git_credentials(repo_path: Path) -> bool:
    """配置 Git 凭证（公开仓库不需要凭证）"""
    # 公开 GitFox 仓库不需要用户名密码
    return True


def _clone_or_init_repo() -> tuple[bool, str, Path]:
    """初始化或克隆仓库"""
    repo_path = settings.skills_repo_dir

    if _is_git_repo(repo_path):
        logger.info(f"Git repo already exists at {repo_path}")
        return True, "Repository already initialized", repo_path

    # 确保父目录存在
    repo_path.parent.mkdir(parents=True, exist_ok=True)

    # 克隆仓库（公开仓库不需要认证）
    repo_url = settings.gitfox_repo_url

    logger.info(f"Cloning repository from {repo_url}")

    # 使用 shallow clone 加快速度
    success, msg = _run_git_command(
        repo_path.parent,
        "clone",
        "--depth", "1",
        "-b", settings.gitfox_branch,
        repo_url,
        repo_path.name
    )

    if not success:
        return False, f"Clone failed: {msg}", repo_path

    logger.info(f"Successfully cloned repository to {repo_path}")
    return True, "Repository cloned successfully", repo_path


def _fetch_and_rebase() -> tuple[bool, str, list[str]]:
    """
    执行 git fetch + rebase
    返回: (success, message, conflict_files)
    """
    repo_path = settings.skills_repo_dir

    if not _is_git_repo(repo_path):
        return False, "Not a git repository", []

    # 配置凭证
    _configure_git_credentials(repo_path)

    # Step 1: git fetch origin
    logger.info("Fetching from remote...")
    success, msg = _run_git_command(
        repo_path,
        "fetch", settings.gitfox_remote_name
    )

    if not success:
        return False, f"Git fetch failed: {msg}", []

    # 检查是否有更新 - 通过比较 commit hash
    success, msg = _run_git_command(
        repo_path,
        "rev-parse", "HEAD"
    )
    local_head = msg.strip() if success else ""

    success, msg = _run_git_command(
        repo_path,
        "rev-parse",
        f"{settings.gitfox_remote_name}/{settings.gitfox_branch}"
    )
    remote_head = msg.strip() if success else ""

    if local_head == remote_head and local_head:
        return True, "Already up to date, no changes to pull", []

    # Step 2: git rebase origin/main (处理简单冲突，保留远程版本)
    logger.info("Rebasing...")

    # 先尝试变基
    success, msg = _run_git_command(
        repo_path,
        "rebase", f"{settings.gitfox_remote_name}/{settings.gitfox_branch}"
    )

    conflict_files = []

    if not success:
        # 检查是否有冲突
        if "CONFLICT" in msg or "conflict" in msg.lower():
            logger.warning(f"Conflicts detected during rebase: {msg}")

            # 提取冲突文件列表
            for line in msg.split('\n'):
                if 'CONFLICT' in line.upper():
                    conflict_files.append(line.strip())

            # 如果有冲突，放弃变基，使用远程版本强制覆盖
            logger.info("Aborting rebase and using remote version...")
            _run_git_command(repo_path, "rebase", "--abort")

            # 重置到远程版本
            success, reset_msg = _run_git_command(
                repo_path,
                "reset", "--hard",
                f"{settings.gitfox_remote_name}/{settings.gitfox_branch}"
            )

            if not success:
                return False, f"Failed to reset to remote version: {reset_msg}", conflict_files

            return True, f"Synced with remote (conflicts resolved by remote version)", conflict_files
        else:
            return False, f"Rebase failed: {msg}", []

    return True, "Successfully synced with remote", conflict_files


def _sync_files_to_local() -> tuple[int, list[str]]:
    """
    将仓库文件同步到本地 skills-local 目录
    返回: (sync_count, copied_files)
    """
    src_dir = settings.skills_repo_dir / "skills"
    dst_dir = settings.skills_local_dir

    # 确保目标目录存在
    dst_dir.mkdir(parents=True, exist_ok=True)

    sync_count = 0
    copied_files = []

    # 获取当前本地的 skill IDs
    existing_skills = set()
    if dst_dir.exists():
        existing_skills = {d.name for d in dst_dir.iterdir() if d.is_dir() and not d.name.startswith('__')}

    # 检查源目录是否存在
    if not src_dir.exists():
        logger.warning(f"Skills folder not found in repository: {src_dir}")
        return 0, []

    # 复制 skills 子目录（跳过 .git 和隐藏文件）
    for item in src_dir.iterdir():
        if item.name == ".git" or item.name.startswith('__') or item.name.startswith('.'):
            continue

        if item.is_dir():
            dest = dst_dir / item.name
            # 如果目标已存在，先删除
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(item, dest)
            sync_count += 1
            copied_files.append(item.name)
        elif item.is_file():
            shutil.copy2(item, dst_dir / item.name)
            copied_files.append(item.name)

    logger.info(f"Synced {sync_count} skills from repository: {copied_files}")

    return sync_count, copied_files


def update_skills_from_gitfox() -> SyncResult:
    """
    从 GitFox 仓库更新 Skills
    使用 git fetch + rebase 方式拉取最新文件
    """
    if not settings.git_sync_enabled:
        return SyncResult(
            success=False,
            message="Git sync is disabled"
        )

    # 检查 skills-repo 目录
    repo_path = settings.skills_repo_dir
    if not repo_path.exists():
        return SyncResult(
            success=False,
            message=f"Repository path does not exist: {repo_path}. Please clone the repository first."
        )

    try:
        # Step 1: 初始化或确认仓库
        success, msg, repo_path = _clone_or_init_repo()
        if not success:
            return SyncResult(success=False, message=f"Repository init failed: {msg}")

        # Step 2: 执行 git fetch + rebase
        success, msg, conflict_files = _fetch_and_rebase()
        if not success:
            return SyncResult(success=False, message=f"Sync failed: {msg}")

        # Step 3: 同步文件到本地
        sync_count, copied_files = _sync_files_to_local()

        # Step 4: 清除缓存，重新加载
        clear_cache()

        # 构建返回消息
        if "up to date" in msg.lower():
            final_msg = "Already up to date, no changes needed"
        else:
            final_msg = f"Successfully synced {sync_count} skills from GitFox"

        if conflict_files:
            final_msg += f", {len(conflict_files)} conflict files (used remote version)"

        logger.info(f"Sync completed: {final_msg}")

        return SyncResult(
            success=True,
            message=final_msg,
            sync_count=sync_count,
            conflict_files=conflict_files
        )

    except Exception as e:
        logger.error(f"Sync failed with exception: {e}")
        return SyncResult(
            success=False,
            message=f"Sync failed: {str(e)}"
        )


def sync_from_git() -> SyncResult:
    """兼容旧接口，内部调用 update_skills_from_gitfox"""
    return update_skills_from_gitfox()


def get_sync_status() -> dict:
    """获取同步状态"""
    repo_path = settings.skills_repo_dir
    has_repo = _is_git_repo(repo_path)

    return {
        "git_sync_enabled": settings.git_sync_enabled,
        "gitfox_repo_url": settings.gitfox_repo_url,
        "gitfox_branch": settings.gitfox_branch,
        "has_local_repo": has_repo,
        "skills_repo_dir": str(repo_path),
        "skills_local_dir": str(settings.skills_local_dir),
    }

"""Git sync module that pulls the latest skills from GitFox with fetch + rebase."""
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
    """Run a git command."""
    try:
        # Prepare environment variables.
        run_env = os.environ.copy()
        if env:
            run_env.update(env)

        # Configure Git credential behavior.
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
    """Return whether the directory is a Git repository."""
    return (repo_path / ".git").exists()


def _configure_git_credentials(repo_path: Path) -> bool:
    """Configure Git credentials; public repositories do not need credentials."""
    # Public GitFox repositories do not need username or password.
    return True


def _clone_or_init_repo() -> tuple[bool, str, Path]:
    """Initialize or clone the repository."""
    repo_path = settings.skills_repo_dir

    if _is_git_repo(repo_path):
        logger.info(f"Git repo already exists at {repo_path}")
        return True, "Repository already initialized", repo_path

    # Ensure the parent directory exists.
    repo_path.parent.mkdir(parents=True, exist_ok=True)

    # Clone the repository; public repositories do not need authentication.
    repo_url = settings.gitfox_repo_url

    logger.info(f"Cloning repository from {repo_url}")

    # Use a shallow clone for speed.
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
        Run git fetch + rebase.
        Return (success, message, conflict_files).

    """
    repo_path = settings.skills_repo_dir

    if not _is_git_repo(repo_path):
        return False, "Not a git repository", []

    # Configure credentials.
    _configure_git_credentials(repo_path)

    # Step 1: git fetch origin
    logger.info("Fetching from remote...")
    success, msg = _run_git_command(
        repo_path,
        "fetch", settings.gitfox_remote_name
    )

    if not success:
        return False, f"Git fetch failed: {msg}", []

    # Check for updates by comparing commit hashes.
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

    # Step 2: git rebase origin/main. Simple conflicts keep the remote version.
    logger.info("Rebasing...")

    # Try rebase first.
    success, msg = _run_git_command(
        repo_path,
        "rebase", f"{settings.gitfox_remote_name}/{settings.gitfox_branch}"
    )

    conflict_files = []

    if not success:
        # Check for conflicts.
        if "CONFLICT" in msg or "conflict" in msg.lower():
            logger.warning(f"Conflicts detected during rebase: {msg}")

            # Extract the conflict file list.
            for line in msg.split('\n'):
                if 'CONFLICT' in line.upper():
                    conflict_files.append(line.strip())

            # If conflicts exist, abort rebase and force the remote version.
            logger.info("Aborting rebase and using remote version...")
            _run_git_command(repo_path, "rebase", "--abort")

            # Reset to the remote version.
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
        Sync repository files into the local skills-local directory.
        Return (sync_count, copied_files).

    """
    src_dir = settings.skills_repo_dir / "skills"
    dst_dir = settings.skills_local_dir

    # Ensure the destination directory exists.
    dst_dir.mkdir(parents=True, exist_ok=True)

    sync_count = 0
    copied_files = []

    # Collect current local skill IDs.
    existing_skills = set()
    if dst_dir.exists():
        existing_skills = {d.name for d in dst_dir.iterdir() if d.is_dir() and not d.name.startswith('__')}

    # Check that the source directory exists.
    if not src_dir.exists():
        logger.warning(f"Skills folder not found in repository: {src_dir}")
        return 0, []

    # Copy skills subdirectories, skipping .git and hidden files.
    for item in src_dir.iterdir():
        if item.name == ".git" or item.name.startswith('__') or item.name.startswith('.'):
            continue

        if item.is_dir():
            dest = dst_dir / item.name
            # If the destination exists, remove it first.
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
        Update skills from the GitFox repository using git fetch + rebase.

    """
    if not settings.git_sync_enabled:
        return SyncResult(
            success=False,
            message="Git sync is disabled"
        )

    # Check the skills-repo directory.
    repo_path = settings.skills_repo_dir
    if not repo_path.exists():
        return SyncResult(
            success=False,
            message=f"Repository path does not exist: {repo_path}. Please clone the repository first."
        )

    try:
        # Step 1: initialize or confirm the repository.
        success, msg, repo_path = _clone_or_init_repo()
        if not success:
            return SyncResult(success=False, message=f"Repository init failed: {msg}")

        # Step 2: run git fetch + rebase.
        success, msg, conflict_files = _fetch_and_rebase()
        if not success:
            return SyncResult(success=False, message=f"Sync failed: {msg}")

        # Step 3: sync files to local storage.
        sync_count, copied_files = _sync_files_to_local()

        # Step 4: clear cache and reload.
        clear_cache()

        # Build the return message.
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
    """Compatibility wrapper for the old API."""
    return update_skills_from_gitfox()


def get_sync_status() -> dict:
    """Return synchronization status."""
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

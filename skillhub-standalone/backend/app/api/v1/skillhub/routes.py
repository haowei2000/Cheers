"""SkillHub API routes."""
import logging
import hashlib
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, UploadFile, File
from fastapi import Request
from fastapi.responses import FileResponse

from app.services.manager import (
    get_all_skills, get_skill_by_id, package_skill_to_zip,
    clear_cache, import_skill, delete_skill, update_skill_category
)
from app.services.sync import get_sync_status, update_skills_from_gitfox
from app.config import settings

logger = logging.getLogger("skillhub.routes")

router = APIRouter(prefix="/api/v1/skillhub", tags=["skillhub"])


@router.get("/skills")
async def list_skills(
    category: str | None = Query(None, description="Filter by category"),
    search: str | None = Query(None, description="Search keyword"),
):
    """List all skills."""
    skills = get_all_skills()

    if category:
        skills = [s for s in skills if s.get("category") == category]

    if search:
        keyword = search.lower()
        skills = [
            s for s in skills
            if keyword in s.get("name", "").lower()
            or keyword in s.get("description", "").lower()
            or keyword in " ".join(s.get("tags", [])).lower()
        ]

    return {"skills": skills, "total": len(skills)}


@router.get("/skills/{skill_id}")
async def get_skill_detail(skill_id: str):
    """Get one skill detail."""
    skill = get_skill_by_id(skill_id)
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found")
    return skill


@router.get("/skills/{skill_id}/download")
async def download_skill(skill_id: str):
    """Download a skill as ZIP."""
    zip_path = package_skill_to_zip(skill_id)
    if not zip_path or not zip_path.exists():
        raise HTTPException(status_code=404, detail=f"Failed to package skill '{skill_id}'")

    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=f"{skill_id}.zip"
    )


@router.post("/skills/upload")
async def upload_skill(request: Request, category: str = Query("imported", description="Category")):
    """Upload and import a skill from an archive or folder."""
    try:
        results = []

        # Get uploaded files.
        form = await request.form()
        files_to_process = []

        # Get all files from the form.
        for key, value in form.items():
            # value is an UploadFile object.
            if hasattr(value, 'filename') and hasattr(value, 'read'):
                filename = value.filename
                if filename:
                    files_to_process.append((value, filename))

        if not files_to_process:
            return {"success": False, "message": "请上传文件"}

        for upload_file, filename in files_to_process:
            content = await upload_file.read()
            result = import_skill(content, filename, category)
            results.append(result)

        # Check whether every import succeeded.
        success_count = sum(1 for r in results if r["success"])
        if success_count == len(results):
            return results[0] if len(results) == 1 else {
                "success": True,
                "skill_id": ",".join([r["skill_id"] for r in results if r["success"]]),
                "message": f"成功导入 {success_count} 个技能"
            }
        else:
            # Partial success.
            return {
                "success": True,
                "skill_id": ",".join([r["skill_id"] for r in results if r["success"]]),
                "message": f"成功导入 {success_count}/{len(results)} 个技能"
            }

    except Exception as e:
        logger.error(f"Upload error: {e}")
        # Return plain error details for easier frontend debugging.
        return {"success": False, "message": str(e)}


@router.put("/skills/{skill_id}/category")
async def update_category(skill_id: str, category: str = Query(..., description="New category")):
    """Update skill category."""
    result = update_skill_category(skill_id, category)
    if result["success"]:
        clear_cache()
        return result
    else:
        raise HTTPException(status_code=404, detail=result["message"])


@router.delete("/skills/{skill_id}")
async def remove_skill(skill_id: str):
    """Delete a skill."""
    result = delete_skill(skill_id)
    if result["success"]:
        clear_cache()
        return result
    else:
        raise HTTPException(status_code=404, detail=result["message"])


@router.get("/update")
async def update_skills():
    """Update skills from the GitFox repository with git fetch + rebase."""
    result = update_skills_from_gitfox()
    return result.to_dict()


@router.get("/status")
async def get_status():
    """Get sync status."""
    return get_sync_status()


@router.get("/categories")
async def get_categories():
    """Get all categories."""
    skills = get_all_skills()
    categories = sorted(set(s.get("category", "general") for s in skills))
    return {"categories": categories}


# ============================================================
# OpenClaw-specific read-only, safe, fast API.
# ============================================================

def _verify_api_key(request: Request) -> bool:
    """Verify API Key."""
    api_key = settings.openclaw_api_key

    # Get API Key from request headers.
    auth_header = request.headers.get("Authorization", "")
    if not auth_header:
        return False

    if not auth_header.startswith("Bearer "):
        return False

    token = auth_header[7:]
    if not api_key:
        # Reject access when no API Key is configured; security first.
        logger.warning("API Key not configured, rejecting request")
        return False

    return token == api_key


def _generate_checksum(data: str) -> str:
    """Generate SHA256 checksum for data."""
    return hashlib.sha256(data.encode()).hexdigest()[:16]


@router.get("/openclaw/skills")
async def openclaw_list_skills(request: Request):
    """
    OpenClaw reads all available skills through this read-only endpoint.
    The response is lightweight, standardized, and easy for OpenClaw to parse.
    """
    if not _verify_api_key(request):
        raise HTTPException(status_code=401, detail="Unauthorized: Invalid API key")

    skills = get_all_skills()

    # Keep the response compact and only include information OpenClaw needs.
    result = {
        "version": "1.0",
        "count": len(skills),
        "checksum": _generate_checksum(json.dumps([s["id"] for s in skills], sort_keys=True)),
        "skills": [
            {
                "id": s["id"],
                "name": s["name"],
                "version": s.get("version", "1.0.0"),
                "description": s.get("description", ""),
                "category": s.get("category", "general"),
                "author": s.get("author", ""),
                "tags": s.get("tags", []),
                "update_time": s.get("update_time", ""),
            }
            for s in skills
        ]
    }

    return result


@router.get("/openclaw/skills/{skill_id}")
async def openclaw_get_skill(request: Request, skill_id: str):
    """
    OpenClaw reads one skill detail through this read-only endpoint.
    Return full metadata and file list.
    """
    if not _verify_api_key(request):
        raise HTTPException(status_code=401, detail="Unauthorized: Invalid API key")

    skill = get_skill_by_id(skill_id)
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found")

    # Compact response.
    return {
        "id": skill["id"],
        "name": skill["name"],
        "version": skill.get("version", "1.0.0"),
        "description": skill.get("description", ""),
        "category": skill.get("category", "general"),
        "author": skill.get("author", ""),
        "tags": skill.get("tags", []),
        "update_time": skill.get("update_time", ""),
        "files": skill.get("files", []),
        "readme": skill.get("readme", ""),
    }


@router.get("/openclaw/skills/{skill_id}/manifest")
async def openclaw_get_skill_manifest(request: Request, skill_id: str):
    """
    OpenClaw reads a skill manifest through this read-only endpoint.
    Return the full skill.json content directly for immediate use.
    """
    if not _verify_api_key(request):
        raise HTTPException(status_code=401, detail="Unauthorized: Invalid API key")

    skill = get_skill_by_id(skill_id)
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found")

    return skill


@router.get("/openclaw/categories")
async def openclaw_get_categories(request: Request):
    """
    OpenClaw reads all categories and skill counts through this read-only endpoint.
    """
    if not _verify_api_key(request):
        raise HTTPException(status_code=401, detail="Unauthorized: Invalid API key")

    skills = get_all_skills()

    # Count by category.
    category_stats = {}
    for s in skills:
        cat = s.get("category", "general")
        if cat not in category_stats:
            category_stats[cat] = {"count": 0, "skills": []}
        category_stats[cat]["count"] += 1
        category_stats[cat]["skills"].append(s["id"])

    return {
        "version": "1.0",
        "categories": category_stats,
    }


@router.get("/openclaw/search")
async def openclaw_search_skills(
    request: Request,
    q: str = Query(..., description="Search keyword"),
    category: str | None = Query(None, description="Filter by category"),
    limit: int = Query(10, description="Result limit"),
):
    """
    OpenClaw searches skills through this read-only endpoint.
    Supports keyword search and category filtering.
    """
    if not _verify_api_key(request):
        raise HTTPException(status_code=401, detail="Unauthorized: Invalid API key")

    skills = get_all_skills()

    # Search filtering.
    results = []
    keyword = q.lower()

    for s in skills:
        # Category filtering.
        if category and s.get("category") != category:
            continue

        # Keyword matching.
        if keyword in s.get("name", "").lower():
            results.append(s)
        elif keyword in s.get("description", "").lower():
            results.append(s)
        elif any(keyword in tag.lower() for tag in s.get("tags", [])):
            results.append(s)

        # Limit reached.
        if len(results) >= limit:
            break

    return {
        "query": q,
        "count": len(results),
        "skills": [
            {
                "id": s["id"],
                "name": s["name"],
                "version": s.get("version", "1.0.0"),
                "description": s.get("description", ""),
                "category": s.get("category", "general"),
                "tags": s.get("tags", []),
            }
            for s in results
        ]
    }


@router.get("/openclaw/paths")
async def openclaw_get_skill_paths(request: Request):
    """
    OpenClaw reads all local skill paths through this read-only endpoint.
    Return local paths so OpenClaw can use them without downloading.
    """
    if not _verify_api_key(request):
        raise HTTPException(status_code=401, detail="Unauthorized: Invalid API key")

    skills = get_all_skills()

    return {
        "version": "1.0",
        "count": len(skills),
        "skills": [
            {
                "id": s["id"],
                "name": s["name"],
                "files": s.get("files", [])[:5],  # Return the first 5 files as a preview.
            }
            for s in skills
        ]
    }


@router.get("/openclaw/paths/{skill_id}")
async def openclaw_get_skill_path(request: Request, skill_id: str):
    """
    OpenClaw reads one skill local path through this read-only endpoint.
    """
    if not _verify_api_key(request):
        raise HTTPException(status_code=401, detail="Unauthorized: Invalid API key")

    skill_path = settings.skills_local_dir / skill_id
    if not skill_path.exists():
        raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found")

    # Get file list.
    files = []
    if skill_path.is_dir():
        for item in skill_path.rglob("*"):
            if item.is_file() and not item.name.startswith("."):
                rel_path = item.relative_to(skill_path)
                files.append(str(rel_path))

    return {
        "id": skill_id,
        "exists": True,
        "files": files,
        "has_skill_json": (skill_path / "skill.json").exists(),
        "has_readme": (skill_path / "README.md").exists(),
        "has_skill_md": (skill_path / "SKILL.md").exists(),
    }


@router.get("/openclaw/config")
async def openclaw_get_config(request: Request):
    """
    OpenClaw reads SkillHub configuration through this read-only endpoint.
    """
    if not _verify_api_key(request):
        raise HTTPException(status_code=401, detail="Unauthorized: Invalid API key")

    return {
        "version": "1.0",
        "api_base": "/api/v1/skillhub",
        "git_sync_enabled": settings.git_sync_enabled,
        "endpoints": {
            "list_skills": "/openclaw/skills",
            "get_skill": "/openclaw/skills/{skill_id}",
            "get_paths": "/openclaw/paths",
            "get_path": "/openclaw/paths/{skill_id}",
            "categories": "/openclaw/categories",
            "search": "/openclaw/search",
            "config": "/openclaw/config",
        }
    }

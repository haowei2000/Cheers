"""Core skill management logic."""
import json
import logging
import os
import re
import shutil
import tarfile
import zipfile
from pathlib import Path
from typing import Any

from app.config import settings
from app.models import SkillInfo

logger = logging.getLogger("skillhub.manager")

# Cache.
_skills_cache: list[SkillInfo] | None = None

# Supported archive formats.
SUPPORTED_ARCHIVES = {'.zip', '.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tar.xz', '.txz'}


def _is_archive(filename: str) -> bool:
    """Return whether the file is a supported archive."""
    lower = filename.lower()
    for ext in SUPPORTED_ARCHIVES:
        if lower.endswith(ext):
            return True
    return False


def _get_archive_type(filename: str) -> str:
    """Return the archive type."""
    lower = filename.lower()
    if lower.endswith('.zip'):
        return 'zip'
    elif lower.endswith('.tar.gz') or lower.endswith('.tgz'):
        return 'tar.gz'
    elif lower.endswith('.tar.bz2') or lower.endswith('.tbz2'):
        return 'tar.bz2'
    elif lower.endswith('.tar.xz') or lower.endswith('.txz'):
        return 'tar.xz'
    elif lower.endswith('.tar'):
        return 'tar'
    return 'unknown'


def _generate_skill_json(skill_id: str, name: str, category: str, files: list) -> dict:
    """Generate the default skill.json."""
    import datetime
    return {
        "id": skill_id,
        "name": name,
        "version": "1.0.0",
        "description": f"Imported from archive: {name}",
        "category": category,
        "author": "imported",
        "support_openclaw_version": ">=1.0.0",
        "update_time": datetime.datetime.now().strftime("%Y-%m-%d"),
        "tags": ["imported"],
        "files": files
    }


def _safe_extract(archive_path: Path, extract_to: Path) -> bool:
    """
        Extract safely and prevent path traversal attacks.
        Check every file path to ensure writes stay inside the target directory.

    """
    archive_type = _get_archive_type(str(archive_path))
    extract_funcs = {
        'zip': _extract_zip_safe,
        'tar.gz': _extract_tar_safe,
        'tar.bz2': _extract_tar_safe,
        'tar.xz': _extract_tar_safe,
        'tar': _extract_tar_safe,
    }

    func = extract_funcs.get(archive_type)
    if not func:
        return False

    return func(archive_path, extract_to)


def _extract_zip_safe(archive_path: Path, extract_to: Path) -> bool:
    """Extract a ZIP safely and prevent path traversal."""
    with zipfile.ZipFile(archive_path, 'r') as zf:
        for info in zf.infolist():
            # Normalize the path and ensure it stays inside the target directory.
            member_path = (extract_to / info.filename).resolve()
            if not str(member_path).startswith(str(extract_to.resolve())):
                logger.warning(f"Blocked path traversal: {info.filename}")
                return False
        # All paths are safe; extract.
        zf.extractall(extract_to)
    return True


def _extract_tar_safe(archive_path: Path, extract_to: Path) -> bool:
    """Extract a TAR safely and prevent path traversal."""
    mode_map = {
        'tar.gz': 'r:gz',
        'tar.bz2': 'r:bz2',
        'tar.xz': 'r:xz',
        'tar': 'r:',
    }
    lower = str(archive_path).lower()
    mode = 'r:*'
    for k, v in mode_map.items():
        if lower.endswith(k):
            mode = v
            break

    with tarfile.open(archive_path, mode) as tf:
        for member in tf.getmembers():
            if member.isfile() or member.isdir():
                # Normalize and check the path; tar member names may contain paths.
                member_path = (extract_to / member.name).resolve()
                if not str(member_path).startswith(str(extract_to.resolve())):
                    logger.warning(f"Blocked tar path traversal: {member.name}")
                    return False
        # All paths are safe; extract.
        tf.extractall(extract_to)
    return True


def _extract_and_find_skill(archive_path: Path, extract_to: Path) -> tuple[Path | None, str]:
    """
        Extract the archive and find the directory that contains skill.json.
        Return (skill_dir, skill_id), or (None, error_msg) on failure.

    """
    temp_extract = extract_to / "__temp_extract__"
    temp_extract.mkdir(exist_ok=True)

    try:
        # Extract safely.
        if not _safe_extract(archive_path, temp_extract):
            return None, "Archive contains an unsafe path and was blocked"

        # Find skill.json.
        skill_dir = None

        for root, dirs, files in os.walk(temp_extract):
            if 'skill.json' in files:
                skill_json_path = Path(root) / 'skill.json'
                skill_dir = Path(root)
                break

        if not skill_dir:
            # Without skill.json, use the first extracted directory as skill_dir.
            for item in temp_extract.iterdir():
                if item.is_dir():
                    skill_dir = item
                    break
            if not skill_dir:
                # If there are only files, use temp_extract itself.
                skill_dir = temp_extract

        # Resolve skill_id from the directory name.
        skill_id = skill_dir.name
        if skill_id == "__temp_extract__":
            # Use the archive name as skill_id.
            skill_id = archive_path.stem
            # Remove possible suffixes such as .tar.
            for ext in ['.tar', '.gz', '.bz2', '.xz']:
                if skill_id.endswith(ext):
                    skill_id = skill_id.replace(ext, '')
            skill_id = skill_id.replace('-', '_').replace(' ', '_')

        # Move content into the target directory.
        target_dir = extract_to / skill_id

        # If the target exists, generate a unique directory and keep the old version.
        if target_dir.exists():
            import uuid
            new_id = f"{skill_id}_{uuid.uuid4().hex[:6]}"
            target_dir = extract_to / new_id
            skill_id = new_id
            logger.info(f"Target exists, created new skill ID: {skill_id}")

        # Create the target directory.
        target_dir.mkdir(parents=True, exist_ok=True)

        # Copy all content, excluding the temp directory itself.
        for item in skill_dir.iterdir():
            dest = target_dir / item.name
            if item.is_dir():
                shutil.copytree(item, dest, dirs_exist_ok=True)
            else:
                shutil.copy2(item, dest)

        return target_dir, skill_id

    except Exception as e:
        logger.error(f"Extraction failed: {e}")
        return None, str(e)
    finally:
        # Clean up the temp directory.
        if temp_extract.exists():
            shutil.rmtree(temp_extract, ignore_errors=True)


def _parse_skill_md(skill_md_path: Path) -> dict | None:
    """Parse YAML frontmatter from a SKILL.md file."""
    try:
        content = skill_md_path.read_text(encoding="utf-8")
        # Match YAML frontmatter (--- ... ---).
        match = re.match(r'^---\s*\n(.*?)\n---', content, re.DOTALL)
        if not match:
            return None

        yaml_content = match.group(1)
        data = {}

        # Improved YAML parsing: support values that contain colons.
        yaml_pattern = re.compile(r'^([^:]+):\s*(.*)$')
        for line in yaml_content.split('\n'):
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            match = yaml_pattern.match(line)
            if match:
                key = match.group(1).strip()
                value = match.group(2).strip()
                # Remove wrapping quotes.
                if value.startswith('"') and value.endswith('"'):
                    value = value[1:-1]
                elif value.startswith("'") and value.endswith("'"):
                    value = value[1:-1]
                data[key] = value

        return data if data else None
    except Exception as e:
        logger.debug(f"Failed to parse SKILL.md: {e}")
        return None


def _scan_skills_dir() -> list[SkillInfo]:
    """Scan skills-local and parse all skill.json or SKILL.md files."""
    skills = []
    skills_dir = settings.skills_local_dir

    if not skills_dir.exists():
        logger.warning(f"Skills directory not found: {skills_dir}")
        return skills

    for item in skills_dir.iterdir():
        if not item.is_dir():
            continue

        skill_json = item / "skill.json"
        skill_md = item / "SKILL.md"

        # Prefer skill.json, otherwise try SKILL.md.
        if skill_json.exists():
            skill_info = SkillInfo.from_json(skill_json)
            if skill_info:
                skills.append(skill_info)
                logger.debug(f"Loaded skill: {skill_info.name} v{skill_info.version}")
        elif skill_md.exists():
            skill_info = SkillInfo.from_skill_md(skill_md)
            if skill_info:
                skills.append(skill_info)
                logger.debug(f"Loaded skill from SKILL.md: {skill_info.name} v{skill_info.version}")
        else:
            logger.debug(f"Skip {item.name}: no skill.json or SKILL.md")

    return skills


def get_all_skills(force_refresh: bool = False) -> list[dict[str, Any]]:
    """Return all skills."""
    global _skills_cache

    if _skills_cache is None or force_refresh:
        _skills_cache = _scan_skills_dir()

    return [s.to_dict() for s in _skills_cache]


def get_skill_by_id(skill_id: str) -> dict[str, Any] | None:
    """Return one skill detail by id."""
    skills = get_all_skills()
    for skill in skills:
        if skill["id"] == skill_id:
            # Attach README content.
            skill_dir = settings.skills_local_dir / skill_id
            readme_path = skill_dir / "README.md"
            if readme_path.exists():
                try:
                    skill["readme"] = readme_path.read_text(encoding="utf-8")
                except Exception:
                    skill["readme"] = ""

            # Try SKILL.md because some skills use this filename.
            if not skill.get("readme"):
                skill_md = skill_dir / "SKILL.md"
                if skill_md.exists():
                    try:
                        skill["readme"] = skill_md.read_text(encoding="utf-8")
                    except Exception:
                        pass

            # Scan actual files.
            actual_files = []
            if skill_dir.exists():
                for root, dirs, files in os.walk(skill_dir):
                    # Skip hidden directories.
                    dirs[:] = [d for d in dirs if not d.startswith('.')]
                    for f in files:
                        if not f.startswith('.'):
                            full_path = Path(root) / f
                            rel_path = full_path.relative_to(skill_dir)
                            actual_files.append(str(rel_path))
            skill["files"] = actual_files

            return skill
    return None


def get_skill_path(skill_id: str) -> Path | None:
    """Return the skill directory path."""
    skill_dir = settings.skills_local_dir / skill_id
    if skill_dir.exists() and skill_dir.is_dir():
        return skill_dir
    return None


def package_skill_to_zip(skill_id: str) -> Path | None:
    """Package a skill as ZIP, using a temp file to tolerate mid-write failure."""
    skill_dir = get_skill_path(skill_id)
    if not skill_dir:
        return None

    zip_path = settings.skills_local_dir / f"{skill_id}.zip"
    temp_zip_path = settings.skills_local_dir / f"__{skill_id}_temp.zip"

    try:
        # Package into a temp file first.
        with zipfile.ZipFile(temp_zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(skill_dir):
                # Skip hidden directories.
                dirs[:] = [d for d in dirs if not d.startswith('.')]
                for file in files:
                    if file.startswith('.'):
                        continue
                    file_path = Path(root) / file
                    arcname = file_path.relative_to(skill_dir)
                    zf.write(file_path, arcname)

        # Packaging succeeded; replace the old file.
        if zip_path.exists():
            zip_path.unlink()
        temp_zip_path.rename(zip_path)

        logger.info(f"Packaged skill {skill_id} to {zip_path}")
        return zip_path
    except Exception as e:
        logger.error(f"Failed to package skill {skill_id}: {e}")
        # Clean up the temp file.
        if temp_zip_path.exists():
            temp_zip_path.unlink()
        return None


def import_skill(file_content: bytes, filename: str, category: str = "imported") -> dict:
    """
        Import a skill file or archive.
        Args:
            file_content: File content.
            filename: Original filename.
            category: Optional category.
        Returns: {"success": bool, "skill_id": str, "message": str}

    """
    global _skills_cache

    skills_dir = settings.skills_local_dir
    skills_dir.mkdir(parents=True, exist_ok=True)

    # Generate a temp file.
    safe_filename = filename.replace('/', '_').replace('\\', '_')
    temp_path = skills_dir / f"__temp_{safe_filename}"

    try:
        # Write the temp file.
        with open(temp_path, 'wb') as f:
            f.write(file_content)

        if not _is_archive(filename):
            # Not an archive; it may be folder upload content.
            return _process_folder_upload(temp_path, filename, category, skills_dir)

        # Extract and find the skill directory.
        skill_dir, result = _extract_and_find_skill(temp_path, skills_dir)

        if skill_dir is None:
            return {"success": False, "skill_id": "", "message": f"Extraction failed: {result}"}

        return _save_skill(skill_dir, category, skills_dir)

    except Exception as e:
        logger.error(f"Import failed: {e}")
        return {"success": False, "skill_id": "", "message": f"Import failed: {str(e)}"}
    finally:
        # Clean up the temp file.
        if temp_path.exists():
            temp_path.unlink()


def _process_folder_upload(file_path: Path, original_name: str, category: str, skills_dir: Path) -> dict:
    """
        Process folder uploads from multiple webkitdirectory files.
        Use file paths to determine whether they belong to the same skill.

    """
    global _skills_cache

    # webkitdirectory uploads preserve relative path structure, for example
    # skill-name/skill.json or skill-name/README.md. Parse the relative path to
    # determine which skill owns the file.

    try:
        content = file_path.read_bytes()

        # Parse the file path and resolve skill_id. The path may look like
        # skill-name/skill.json or skill-name/README.md.
        relative_path = file_path.name  # Use filename as the relative path.

        # Try to get skill_id from the filename; for skill.json, read it from content.
        skill_id = None

        if file_path.name == 'skill.json':
            try:
                data = json.loads(content)
                skill_id = data.get('id', '')
                if not skill_id:
                    # Try the filename as the ID.
                    skill_id = file_path.stem
            except:
                skill_id = file_path.stem
        elif file_path.name in ['README.md', 'SKILL.md', 'main.py', '__init__.py']:
            # These files usually live beside skill.json.
            skill_id = file_path.stem
        else:
            # For other files, use the filename as skill_id.
            skill_id = file_path.stem

        if not skill_id or skill_id in ['__temp__', '__temp']:
            skill_id = original_name.replace('.', '_').replace('-', '_')

        # Generate a unique ID.
        import uuid
        final_skill_id = f"{skill_id}_{uuid.uuid4().hex[:6]}"
        skill_dir = skills_dir / final_skill_id
        skill_dir.mkdir(parents=True, exist_ok=True)

        # Handle by file type.
        if file_path.name == 'skill.json':
            # Copy skill.json directly.
            (skill_dir / 'skill.json').write_bytes(content)

            # Update category.
            try:
                data = json.loads(content)
                data['category'] = category
                with open(skill_dir / 'skill.json', 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
            except:
                pass
        else:
            # Copy other files such as md, json, py, and txt directly.
            dest_file = skill_dir / file_path.name
            dest_file.write_bytes(content)

            # Create a default skill.json if missing.
            if not (skill_dir / 'skill.json').exists():
                # Collect the file list.
                files_list = [f.name for f in skill_dir.iterdir() if f.is_file()]
                default_json = _generate_skill_json(
                    final_skill_id,
                    skill_id.replace('-', ' ').replace('_', ' ').title(),
                    category,
                    files_list
                )
                with open(skill_dir / 'skill.json', 'w', encoding='utf-8') as f:
                    json.dump(default_json, f, ensure_ascii=False, indent=2)

        _skills_cache = None
        return {
            "success": True,
            "skill_id": final_skill_id,
            "message": f"Imported skill successfully: {final_skill_id}"
        }

    except Exception as e:
        logger.error(f"Folder import error: {e}")
        return {"success": False, "skill_id": "", "message": f"Import failed: {str(e)}"}


def _save_skill(skill_dir: Path, category: str, skills_dir: Path) -> dict:
    """Save a skill to the directory and update its category."""
    global _skills_cache

    skill_id = skill_dir.name

    # Safety check: ensure the directory exists.
    if not skill_dir.exists():
        return {"success": False, "skill_id": "", "message": f"Skill directory does not exist: {skill_id}"}

    # Scan actual files.
    actual_files = []
    for root, dirs, files_list in os.walk(skill_dir):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for f in files_list:
            if not f.startswith('.') and f != '__pycache__':
                full_path = Path(root) / f
                rel_path = full_path.relative_to(skill_dir)
                actual_files.append(str(rel_path))

    # Update or create skill.json.
    skill_json = skill_dir / "skill.json"

    if skill_json.exists():
        # Update the existing skill.json category.
        try:
            with open(skill_json, 'r', encoding='utf-8') as f:
                data = json.load(f)
            data['category'] = category
            with open(skill_json, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.warning(f"Failed to update skill.json: {e}")
    else:
        # Create a new skill.json.
        name = skill_id.replace('-', ' ').replace('_', ' ').title()
        default_json = _generate_skill_json(skill_id, name, category, actual_files)
        with open(skill_json, 'w', encoding='utf-8') as f:
            json.dump(default_json, f, ensure_ascii=False, indent=2)

    # Clear cache.
    _skills_cache = None

    logger.info(f"Imported skill: {skill_id} with category: {category}")
    return {
        "success": True,
        "skill_id": skill_id,
        "message": f"Imported skill successfully: {skill_id}"
    }


def update_skill_category(skill_id: str, category: str) -> dict:
    """Update a skill category."""
    global _skills_cache

    skill_dir = get_skill_path(skill_id)
    if not skill_dir:
        return {"success": False, "message": "Skill does not exist"}

    skill_json = skill_dir / "skill.json"
    skill_md = skill_dir / "SKILL.md"

    if skill_json.exists():
        # Update skill.json.
        try:
            with open(skill_json, 'r', encoding='utf-8') as f:
                data = json.load(f)
            data['category'] = category
            with open(skill_json, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            return {"success": False, "message": f"Failed to update skill.json: {e}"}
    elif skill_md.exists():
        # Update SKILL.md YAML frontmatter.
        try:
            content = skill_md.read_text(encoding='utf-8')
            match = re.match(r'^(---)(.*?)(---\s*\n)', content, re.DOTALL)
            if match:
                # Extract existing frontmatter lines.
                existing_lines = [l.strip() for l in match.group(2).split('\n') if l.strip()]
                # Remove existing category lines, if any.
                existing_lines = [l for l in existing_lines if not l.startswith('category:')]
                # Add the new category line.
                existing_lines.append(f'category: {category}')
                # Rebuild frontmatter.
                frontmatter = '---\n' + '\n'.join(existing_lines) + '\n---\n'
                new_content = frontmatter + content[match.end(3):]
                skill_md.write_text(new_content, encoding='utf-8')
            else:
                return {"success": False, "message": "Invalid SKILL.md format"}
        except Exception as e:
            return {"success": False, "message": f"Failed to update SKILL.md: {e}"}
    else:
        return {"success": False, "message": "No skill.json or SKILL.md found"}

    _skills_cache = None
    return {"success": True, "message": f"Category updated to: {category}"}


def delete_skill(skill_id: str) -> dict:
    """Delete a skill."""
    global _skills_cache

    # Safety check: ensure skill_id has no path traversal characters.
    if '..' in skill_id or '/' in skill_id or '\\' in skill_id:
        logger.warning(f"Invalid skill_id: {skill_id}")
        return {"success": False, "message": "Invalid skill ID"}

    skill_dir = get_skill_path(skill_id)
    if not skill_dir:
        return {"success": False, "message": "Skill does not exist"}

    try:
        shutil.rmtree(skill_dir)
        _skills_cache = None
        logger.info(f"Deleted skill: {skill_id}")
        return {"success": True, "message": f"Deleted skill: {skill_id}"}
    except Exception as e:
        logger.error(f"Delete failed: {e}")
        return {"success": False, "message": f"Delete failed: {str(e)}"}


def clear_cache():
    """Clear cache and force a rescan."""
    global _skills_cache
    _skills_cache = None

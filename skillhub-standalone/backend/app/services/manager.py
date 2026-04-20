"""Skill 管理核心逻辑"""
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

# 缓存
_skills_cache: list[SkillInfo] | None = None

# 支持的压缩格式
SUPPORTED_ARCHIVES = {'.zip', '.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tar.xz', '.txz'}


def _is_archive(filename: str) -> bool:
    """判断是否为支持的压缩文件"""
    lower = filename.lower()
    for ext in SUPPORTED_ARCHIVES:
        if lower.endswith(ext):
            return True
    return False


def _get_archive_type(filename: str) -> str:
    """获取压缩文件类型"""
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
    """生成默认 skill.json"""
    import datetime
    return {
        "id": skill_id,
        "name": name,
        "version": "1.0.0",
        "description": f"从压缩包导入的技能: {name}",
        "category": category,
        "author": "imported",
        "support_openclaw_version": ">=1.0.0",
        "update_time": datetime.datetime.now().strftime("%Y-%m-%d"),
        "tags": ["imported"],
        "files": files
    }


def _safe_extract(archive_path: Path, extract_to: Path) -> bool:
    """
    安全解压：防止路径穿越攻击
    检查每个文件路径，确保不会写到目标目录之外
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
    """安全解压 ZIP，防止路径穿越"""
    with zipfile.ZipFile(archive_path, 'r') as zf:
        for info in zf.infolist():
            # 规范化路径并检查是否在目标目录内
            member_path = (extract_to / info.filename).resolve()
            if not str(member_path).startswith(str(extract_to.resolve())):
                logger.warning(f"Blocked path traversal: {info.filename}")
                return False
        # 所有路径安全，解压
        zf.extractall(extract_to)
    return True


def _extract_tar_safe(archive_path: Path, extract_to: Path) -> bool:
    """安全解压 TAR，防止路径穿越"""
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
                # 规范化路径并检查
                # tar 文件的 name 可能包含路径
                member_path = (extract_to / member.name).resolve()
                if not str(member_path).startswith(str(extract_to.resolve())):
                    logger.warning(f"Blocked tar path traversal: {member.name}")
                    return False
        # 所有路径安全，解压
        tf.extractall(extract_to)
    return True


def _extract_and_find_skill(archive_path: Path, extract_to: Path) -> tuple[Path | None, str]:
    """
    解压压缩包并查找 skill.json 所在目录
    返回: (skill_dir, skill_id) 如果失败则返回 (None, error_msg)
    """
    temp_extract = extract_to / "__temp_extract__"
    temp_extract.mkdir(exist_ok=True)

    try:
        # 安全解压
        if not _safe_extract(archive_path, temp_extract):
            return None, "压缩包包含非法路径，已被阻止"

        # 查找 skill.json
        skill_dir = None

        for root, dirs, files in os.walk(temp_extract):
            if 'skill.json' in files:
                skill_json_path = Path(root) / 'skill.json'
                skill_dir = Path(root)
                break

        if not skill_dir:
            # 没有 skill.json，用解压后的第一个目录作为 skill 目录
            for item in temp_extract.iterdir():
                if item.is_dir():
                    skill_dir = item
                    break
            if not skill_dir:
                # 如果只有文件，用 temp_extract 本身
                skill_dir = temp_extract

        # 确定 skill_id（目录名）
        skill_id = skill_dir.name
        if skill_id == "__temp_extract__":
            # 用压缩包名作为 skill_id
            skill_id = archive_path.stem
            # 去掉可能的 .tar 等后缀
            for ext in ['.tar', '.gz', '.bz2', '.xz']:
                if skill_id.endswith(ext):
                    skill_id = skill_id.replace(ext, '')
            skill_id = skill_id.replace('-', '_').replace(' ', '_')

        # 移动内容到目标目录
        target_dir = extract_to / skill_id

        # 如果目标已存在，生成新的唯一目录名（不覆盖，保留旧版本）
        if target_dir.exists():
            import uuid
            new_id = f"{skill_id}_{uuid.uuid4().hex[:6]}"
            target_dir = extract_to / new_id
            skill_id = new_id
            logger.info(f"Target exists, created new skill ID: {skill_id}")

        # 创建目标目录
        target_dir.mkdir(parents=True, exist_ok=True)

        # 复制所有内容（跳过临时目录本身）
        for item in skill_dir.iterdir():
            dest = target_dir / item.name
            if item.is_dir():
                shutil.copytree(item, dest, dirs_exist_ok=True)
            else:
                shutil.copy2(item, dest)

        return target_dir, skill_id

    except Exception as e:
        logger.error(f"解压失败: {e}")
        return None, str(e)
    finally:
        # 清理临时目录
        if temp_extract.exists():
            shutil.rmtree(temp_extract, ignore_errors=True)


def _parse_skill_md(skill_md_path: Path) -> dict | None:
    """解析 SKILL.md 文件的 YAML frontmatter"""
    try:
        content = skill_md_path.read_text(encoding="utf-8")
        # 匹配 YAML frontmatter (--- ... ---)
        match = re.match(r'^---\s*\n(.*?)\n---', content, re.DOTALL)
        if not match:
            return None

        yaml_content = match.group(1)
        data = {}

        # 改进的 YAML 解析：支持值中包含冒号
        yaml_pattern = re.compile(r'^([^:]+):\s*(.*)$')
        for line in yaml_content.split('\n'):
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            match = yaml_pattern.match(line)
            if match:
                key = match.group(1).strip()
                value = match.group(2).strip()
                # 去除引号
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
    """扫描 skills-local 目录，解析所有 skill.json 或 SKILL.md"""
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

        # 优先使用 skill.json，否则尝试 SKILL.md
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
    """获取所有 Skill 列表"""
    global _skills_cache

    if _skills_cache is None or force_refresh:
        _skills_cache = _scan_skills_dir()

    return [s.to_dict() for s in _skills_cache]


def get_skill_by_id(skill_id: str) -> dict[str, Any] | None:
    """获取单个 Skill 详情"""
    skills = get_all_skills()
    for skill in skills:
        if skill["id"] == skill_id:
            # 附加 README 内容
            skill_dir = settings.skills_local_dir / skill_id
            readme_path = skill_dir / "README.md"
            if readme_path.exists():
                try:
                    skill["readme"] = readme_path.read_text(encoding="utf-8")
                except Exception:
                    skill["readme"] = ""

            # 尝试读取 SKILL.md（某些 skill 用这个文件名）
            if not skill.get("readme"):
                skill_md = skill_dir / "SKILL.md"
                if skill_md.exists():
                    try:
                        skill["readme"] = skill_md.read_text(encoding="utf-8")
                    except Exception:
                        pass

            # 扫描实际文件
            actual_files = []
            if skill_dir.exists():
                for root, dirs, files in os.walk(skill_dir):
                    # 跳过隐藏目录
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
    """获取 Skill 目录路径"""
    skill_dir = settings.skills_local_dir / skill_id
    if skill_dir.exists() and skill_dir.is_dir():
        return skill_dir
    return None


def package_skill_to_zip(skill_id: str) -> Path | None:
    """将 Skill 打包为 ZIP（使用临时文件防止中途失败）"""
    skill_dir = get_skill_path(skill_id)
    if not skill_dir:
        return None

    zip_path = settings.skills_local_dir / f"{skill_id}.zip"
    temp_zip_path = settings.skills_local_dir / f"__{skill_id}_temp.zip"

    try:
        # 先打包到临时文件
        with zipfile.ZipFile(temp_zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(skill_dir):
                # 跳过隐藏目录
                dirs[:] = [d for d in dirs if not d.startswith('.')]
                for file in files:
                    if file.startswith('.'):
                        continue
                    file_path = Path(root) / file
                    arcname = file_path.relative_to(skill_dir)
                    zf.write(file_path, arcname)

        # 打包成功，替换旧文件
        if zip_path.exists():
            zip_path.unlink()
        temp_zip_path.rename(zip_path)

        logger.info(f"Packaged skill {skill_id} to {zip_path}")
        return zip_path
    except Exception as e:
        logger.error(f"Failed to package skill {skill_id}: {e}")
        # 清理临时文件
        if temp_zip_path.exists():
            temp_zip_path.unlink()
        return None


def import_skill(file_content: bytes, filename: str, category: str = "imported") -> dict:
    """
    导入 Skill 文件/压缩包
    参数:
        file_content: 文件内容
        filename: 原文件名
        category: 分类（可选）
    返回: {"success": bool, "skill_id": str, "message": str}
    """
    global _skills_cache

    skills_dir = settings.skills_local_dir
    skills_dir.mkdir(parents=True, exist_ok=True)

    # 生成临时文件
    safe_filename = filename.replace('/', '_').replace('\\', '_')
    temp_path = skills_dir / f"__temp_{safe_filename}"

    try:
        # 写入临时文件
        with open(temp_path, 'wb') as f:
            f.write(file_content)

        if not _is_archive(filename):
            # 不是压缩包，可能是文件夹内容
            return _process_folder_upload(temp_path, filename, category, skills_dir)

        # 解压并查找 skill 目录
        skill_dir, result = _extract_and_find_skill(temp_path, skills_dir)

        if skill_dir is None:
            return {"success": False, "skill_id": "", "message": f"解压失败: {result}"}

        return _save_skill(skill_dir, category, skills_dir)

    except Exception as e:
        logger.error(f"Import failed: {e}")
        return {"success": False, "skill_id": "", "message": f"导入失败: {str(e)}"}
    finally:
        # 清理临时文件
        if temp_path.exists():
            temp_path.unlink()


def _process_folder_upload(file_path: Path, original_name: str, category: str, skills_dir: Path) -> dict:
    """
    处理文件夹上传（从 webkitdirectory 上传的多个文件）
    通过文件路径判断它们是否属于同一个 skill
    """
    global _skills_cache

    # webkitdirectory 上传的文件会保留相对路径结构
    # 例如：skill-name/skill.json, skill-name/README.md
    # 我们需要解析相对路径来判断文件属于哪个 skill

    try:
        content = file_path.read_bytes()

        # 解析文件路径，确定 skill_id
        # 文件路径格式可能是：skill-name/skill.json 或 skill-name/README.md
        relative_path = file_path.name  # 使用文件名作为相对路径

        # 尝试从文件名获取 skill_id
        # 如果文件名是 skill.json，从内容中获取 ID
        skill_id = None

        if file_path.name == 'skill.json':
            try:
                data = json.loads(content)
                skill_id = data.get('id', '')
                if not skill_id:
                    # 尝试用文件名作为 ID
                    skill_id = file_path.stem
            except:
                skill_id = file_path.stem
        elif file_path.name in ['README.md', 'SKILL.md', 'main.py', '__init__.py']:
            # 这些文件通常与 skill.json 同目录
            skill_id = file_path.stem
        else:
            # 其他文件，用文件名作为 skill_id
            skill_id = file_path.stem

        if not skill_id or skill_id in ['__temp__', '__temp']:
            skill_id = original_name.replace('.', '_').replace('-', '_')

        # 生成唯一 ID
        import uuid
        final_skill_id = f"{skill_id}_{uuid.uuid4().hex[:6]}"
        skill_dir = skills_dir / final_skill_id
        skill_dir.mkdir(parents=True, exist_ok=True)

        # 根据文件类型处理
        if file_path.name == 'skill.json':
            # skill.json 直接复制
            (skill_dir / 'skill.json').write_bytes(content)

            # 更新分类
            try:
                data = json.loads(content)
                data['category'] = category
                with open(skill_dir / 'skill.json', 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
            except:
                pass
        else:
            # 其他文件：md, json, py, txt 等直接复制
            dest_file = skill_dir / file_path.name
            dest_file.write_bytes(content)

            # 如果没有 skill.json，创建一个默认的
            if not (skill_dir / 'skill.json').exists():
                # 获取文件列表
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
            "message": f"成功导入技能: {final_skill_id}"
        }

    except Exception as e:
        logger.error(f"Folder import error: {e}")
        return {"success": False, "skill_id": "", "message": f"导入失败: {str(e)}"}


def _save_skill(skill_dir: Path, category: str, skills_dir: Path) -> dict:
    """保存 skill 到目录并更新分类"""
    global _skills_cache

    skill_id = skill_dir.name

    # 安全检查：确保目录存在
    if not skill_dir.exists():
        return {"success": False, "skill_id": "", "message": f"技能目录不存在: {skill_id}"}

    # 扫描实际文件
    actual_files = []
    for root, dirs, files_list in os.walk(skill_dir):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for f in files_list:
            if not f.startswith('.') and f != '__pycache__':
                full_path = Path(root) / f
                rel_path = full_path.relative_to(skill_dir)
                actual_files.append(str(rel_path))

    # 更新或创建 skill.json
    skill_json = skill_dir / "skill.json"

    if skill_json.exists():
        # 更新现有 skill.json 的分类
        try:
            with open(skill_json, 'r', encoding='utf-8') as f:
                data = json.load(f)
            data['category'] = category
            with open(skill_json, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.warning(f"更新 skill.json 失败: {e}")
    else:
        # 创建新的 skill.json
        name = skill_id.replace('-', ' ').replace('_', ' ').title()
        default_json = _generate_skill_json(skill_id, name, category, actual_files)
        with open(skill_json, 'w', encoding='utf-8') as f:
            json.dump(default_json, f, ensure_ascii=False, indent=2)

    # 清除缓存
    _skills_cache = None

    logger.info(f"Imported skill: {skill_id} with category: {category}")
    return {
        "success": True,
        "skill_id": skill_id,
        "message": f"成功导入技能: {skill_id}"
    }


def update_skill_category(skill_id: str, category: str) -> dict:
    """更新 Skill 的分类"""
    global _skills_cache

    skill_dir = get_skill_path(skill_id)
    if not skill_dir:
        return {"success": False, "message": "技能不存在"}

    skill_json = skill_dir / "skill.json"
    skill_md = skill_dir / "SKILL.md"

    if skill_json.exists():
        # 更新 skill.json
        try:
            with open(skill_json, 'r', encoding='utf-8') as f:
                data = json.load(f)
            data['category'] = category
            with open(skill_json, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            return {"success": False, "message": f"更新 skill.json 失败: {e}"}
    elif skill_md.exists():
        # 更新 SKILL.md 的 YAML frontmatter
        try:
            content = skill_md.read_text(encoding='utf-8')
            match = re.match(r'^(---)(.*?)(---\s*\n)', content, re.DOTALL)
            if match:
                # 提取现有的 frontmatter 行
                existing_lines = [l.strip() for l in match.group(2).split('\n') if l.strip()]
                # 移除现有的 category 行（如果有）
                existing_lines = [l for l in existing_lines if not l.startswith('category:')]
                # 添加新的 category 行
                existing_lines.append(f'category: {category}')
                # 重建 frontmatter
                frontmatter = '---\n' + '\n'.join(existing_lines) + '\n---\n'
                new_content = frontmatter + content[match.end(3):]
                skill_md.write_text(new_content, encoding='utf-8')
            else:
                return {"success": False, "message": "SKILL.md 格式不正确"}
        except Exception as e:
            return {"success": False, "message": f"更新 SKILL.md 失败: {e}"}
    else:
        return {"success": False, "message": "没有找到 skill.json 或 SKILL.md"}

    _skills_cache = None
    return {"success": True, "message": f"已更新分类为: {category}"}


def delete_skill(skill_id: str) -> dict:
    """删除 Skill"""
    global _skills_cache

    # 安全检查：确保 skill_id 不包含路径穿越字符
    if '..' in skill_id or '/' in skill_id or '\\' in skill_id:
        logger.warning(f"Invalid skill_id: {skill_id}")
        return {"success": False, "message": "无效的技能 ID"}

    skill_dir = get_skill_path(skill_id)
    if not skill_dir:
        return {"success": False, "message": "技能不存在"}

    try:
        shutil.rmtree(skill_dir)
        _skills_cache = None
        logger.info(f"Deleted skill: {skill_id}")
        return {"success": True, "message": f"已删除技能: {skill_id}"}
    except Exception as e:
        logger.error(f"Delete failed: {e}")
        return {"success": False, "message": f"删除失败: {str(e)}"}


def clear_cache():
    """清除缓存，强制重新扫描"""
    global _skills_cache
    _skills_cache = None

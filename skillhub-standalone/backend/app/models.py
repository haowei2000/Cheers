"""Skill 数据模型"""
from datetime import datetime
from pathlib import Path
from typing import Any
import json


class SkillInfo:
    """Skill 元数据"""

    def __init__(self, skill_id: str, name: str, version: str,
                 description: str = "", category: str = "general",
                 author: str = "", support_version: str = "",
                 update_time: str = "", tags: list = None,
                 files: list = None, path: Path = None):
        self.id = skill_id
        self.name = name
        self.version = version
        self.description = description
        self.category = category
        self.author = author
        self.support_version = support_version
        self.update_time = update_time
        self.tags = tags or []
        self.files = files or []
        self.path = path

    @classmethod
    def from_json(cls, json_path: Path) -> "SkillInfo | None":
        """从 skill.json 解析"""
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            skill_dir = json_path.parent
            # 使用目录名作为 skill_id（确保与目录对应，便于删除等操作）
            return cls(
                skill_id=skill_dir.name,
                name=data.get("name", skill_dir.name),
                version=data.get("version", "1.0.0"),
                description=data.get("description", ""),
                category=data.get("category", "general"),
                author=data.get("author", ""),
                support_version=data.get("support_openclaw_version", ""),
                update_time=data.get("update_time", ""),
                tags=data.get("tags", []),
                files=data.get("files", []),
                path=skill_dir
            )
        except Exception:
            return None

    @classmethod
    def from_skill_md(cls, md_path: Path) -> "SkillInfo | None":
        """从 SKILL.md 的 YAML frontmatter 解析"""
        try:
            import re
            content = md_path.read_text(encoding="utf-8")
            match = re.match(r'^---\s*\n(.*?)\n---', content, re.DOTALL)
            if not match:
                return None

            yaml_content = match.group(1)
            data = {}

            # 改进的 YAML 解析：支持值中包含冒号
            # 匹配 key: value，value 可以是引号包围或普通文本
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

            if not data:
                return None

            skill_dir = md_path.parent
            # 如果没有 category，使用目录名作为默认 category
            category_value = data.get("category", "")
            if not category_value:
                category_value = skill_dir.name

            return cls(
                skill_id=skill_dir.name,
                name=data.get("name", skill_dir.name),
                version=data.get("version", "1.0.0"),
                description=data.get("description", ""),
                category=category_value,
                author=data.get("author", ""),
                support_version=data.get("support_openclaw_version", ""),
                update_time=data.get("update_time", ""),
                tags=data.get("tags", "").split(",") if data.get("tags") else [],
                files=data.get("files", "").split(",") if data.get("files") else [],
                path=skill_dir
            )
        except Exception:
            return None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "description": self.description,
            "category": self.category,
            "author": self.author,
            "support_version": self.support_version,
            "update_time": self.update_time,
            "tags": self.tags,
            "files": self.files,
        }


class SyncResult:
    """同步结果"""

    def __init__(self, success: bool, message: str = "",
                 sync_count: int = 0, conflict_files: list = None):
        self.success = success
        self.message = message
        self.sync_count = sync_count
        self.conflict_files = conflict_files or []
        self.timestamp = datetime.now().isoformat()

    def to_dict(self) -> dict:
        return {
            "success": self.success,
            "message": self.message,
            "sync_count": self.sync_count,
            "conflict_files": self.conflict_files,
            "timestamp": self.timestamp,
        }


class SyncLog:
    """同步日志"""

    def __init__(self, status: str = "pending",
                 sync_count: int = 0,
                 conflict_files: list = None,
                 error_msg: str = ""):
        self.id = None  # 内存中不设置 ID
        self.sync_time = datetime.now()
        self.status = status  # success / fail / pending
        self.sync_count = sync_count
        self.conflict_files = conflict_files or []
        self.error_msg = error_msg
        self.create_time = datetime.now()

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "sync_time": self.sync_time.isoformat() if self.sync_time else None,
            "status": self.status,
            "sync_count": self.sync_count,
            "conflict_files": self.conflict_files,
            "error_msg": self.error_msg,
            "create_time": self.create_time.isoformat() if self.create_time else None,
        }

    @classmethod
    def from_result(cls, result: SyncResult) -> "SyncLog":
        """从 SyncResult 创建 SyncLog"""
        return cls(
            status="success" if result.success else "fail",
            sync_count=result.sync_count,
            conflict_files=result.conflict_files,
            error_msg=result.message if not result.success else ""
        )

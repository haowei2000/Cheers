"""MEDIA: 行抽取 + 物化（Bot 回复内联附件协议）。

协议（对齐 OpenClaw gateway）：
  - Bot 回复里每一行 `MEDIA:<本地路径或 URL>` 会被抽出
  - 必须行首出现，不可有前导空格
  - 值支持 http(s) URL 或本地路径
  - 抽到的文件会落成 FileRecord，file_id 追加到消息 file_ids

本模块只管"抽 + 物化"，finalize 的落盘/广播由 bridge service 负责调用。

安全设计：
  - 本地路径 workspaceOnly 白名单（data_dir + media_allowed_dirs，防路径逃逸）
  - URL 仅 http/https，size / timeout cap，跟随重定向但仍按最终 body 计大小
  - 单条回复上限 media_max_refs_per_message，防爆
  - 单个 ref 失败（文件不存在、越界、下载超时）只记日志并跳过，不影响文本落盘
"""
from __future__ import annotations

import logging
import mimetypes
import re
import shutil
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import resolve_data_dir, settings
from app.db.models import FileRecord

logger = logging.getLogger("app.services.openclaw_bridge.media_extract")

# 行首 "MEDIA:" + 非空后缀（不允许前导空格）
_MEDIA_LINE_RE = re.compile(r"^MEDIA:(\S.*?)\s*$", re.MULTILINE)


@dataclass
class MediaExtractResult:
    cleaned_content: str
    refs: list[str]  # 原样保留抽到的 MEDIA 值（路径或 URL）


def extract_media_refs(content: str) -> MediaExtractResult:
    """从 Bot 回复中抽出 MEDIA: 行，返回清洗后的正文 + ref 列表。

    规则：
      - 必须行首 `MEDIA:`（大小写敏感，不允许前导空格）
      - 冒号后第一个字符不能是空白（否则整行视为普通文本，不抽）
      - 抽到的行从 content 中整行删除
      - 超过 media_max_refs_per_message 的部分忽略（仍从文本里删除，防泄漏）
    """
    if not content or "MEDIA:" not in content:
        return MediaExtractResult(cleaned_content=content, refs=[])

    refs: list[str] = []
    for m in _MEDIA_LINE_RE.finditer(content):
        value = m.group(1).strip()
        if value:
            refs.append(value)

    cleaned = _MEDIA_LINE_RE.sub("", content)
    # 抽行后常残留连续空行，合并 3+ 连续换行为 2 个
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip("\n")

    cap = max(1, int(settings.media_max_refs_per_message or 10))
    if len(refs) > cap:
        logger.warning(
            "media_extract: refs count %d exceeds cap %d, dropping extras",
            len(refs), cap,
        )
        refs = refs[:cap]

    return MediaExtractResult(cleaned_content=cleaned, refs=refs)


# ============================================================================
# 路径白名单解析
# ============================================================================

def _allowed_workspace_roots() -> list[Path]:
    """允许作为本地 MEDIA 路径来源的目录根列表（已解析为绝对路径）。"""
    roots: list[Path] = []
    data_root = resolve_data_dir().resolve()
    roots.append(data_root)  # data_dir 整个根全部允许

    extra = (settings.media_allowed_dirs or "").strip()
    if extra:
        for raw in extra.split(","):
            p = raw.strip()
            if not p:
                continue
            try:
                roots.append(Path(p).expanduser().resolve())
            except Exception as exc:  # noqa: BLE001
                logger.warning("media_extract: bad allowed_dirs entry %r: %s", p, exc)
    return roots


def _is_under_allowed_root(target: Path, roots: list[Path]) -> bool:
    try:
        resolved = target.resolve()
    except OSError:
        return False
    for root in roots:
        try:
            if resolved.is_relative_to(root):
                return True
        except ValueError:
            continue
    return False


# ============================================================================
# Ref → FileRecord
# ============================================================================

def _is_url(ref: str) -> bool:
    low = ref.lower()
    return low.startswith("http://") or low.startswith("https://")


def _safe_filename_from_path(p: Path) -> str:
    name = p.name or "media"
    # 只保留常见字符，防奇怪文件名把下游搞炸
    return re.sub(r"[^\w\-. ]", "_", name) or "media"


def _safe_filename_from_url(url: str, fallback_ext: str = "") -> str:
    parsed = urlparse(url)
    base = Path(parsed.path).name if parsed.path else ""
    if not base:
        base = f"download{fallback_ext}"
    return re.sub(r"[^\w\-. ]", "_", base) or "download"


def _guess_content_type(filename: str, fallback: str = "application/octet-stream") -> str:
    ctype, _ = mimetypes.guess_type(filename)
    return ctype or fallback


async def _materialize_local(
    session: AsyncSession,
    *,
    channel_id: str,
    uploader_id: str,
    ref: str,
    max_bytes: int,
) -> str | None:
    """本地路径 → 复制到 generated/{channel_id}/{file_id}{ext} → 建 FileRecord，返回 file_id。"""
    try:
        src = Path(ref).expanduser()
    except Exception as exc:  # noqa: BLE001
        logger.warning("media_extract: bad path %r: %s", ref, exc)
        return None

    if not src.is_absolute():
        # 相对路径以 data_dir 为基
        src = resolve_data_dir() / src

    if not src.exists() or not src.is_file():
        logger.warning("media_extract: local file not found: %s", src)
        return None

    if settings.media_workspace_only:
        roots = _allowed_workspace_roots()
        if not _is_under_allowed_root(src, roots):
            logger.warning(
                "media_extract: path %s outside workspace allowlist (%d roots)",
                src, len(roots),
            )
            return None

    try:
        size = src.stat().st_size
    except OSError as exc:
        logger.warning("media_extract: stat failed for %s: %s", src, exc)
        return None
    if size > max_bytes:
        logger.warning(
            "media_extract: file %s size %d exceeds cap %d", src, size, max_bytes,
        )
        return None

    file_id = str(uuid.uuid4())
    gen_dir = resolve_data_dir() / "generated" / channel_id
    gen_dir.mkdir(parents=True, exist_ok=True)
    suffix = src.suffix.lower()
    dst = gen_dir / f"{file_id}{suffix}"
    if not dst.resolve().is_relative_to(gen_dir.resolve()):
        logger.warning("media_extract: dst path escape blocked: %s", dst)
        return None

    try:
        shutil.copyfile(src, dst)
    except OSError as exc:
        logger.warning("media_extract: copy failed %s -> %s: %s", src, dst, exc)
        return None

    original_name = _safe_filename_from_path(src)
    content_type = _guess_content_type(original_name)
    now = datetime.now(timezone.utc)

    record = FileRecord(
        file_id=file_id,
        channel_id=channel_id,
        uploader_id=uploader_id,
        original_path=str(dst),
        original_filename=original_name,
        content_type=content_type,
        size_bytes=size,
        status="ready",
        uploaded_at=now,
    )
    session.add(record)
    await session.flush()
    logger.info(
        "media_extract: local %s -> file_id=%s (%s, %d bytes)",
        src, file_id, content_type, size,
    )
    return file_id


async def _materialize_url(
    session: AsyncSession,
    *,
    channel_id: str,
    uploader_id: str,
    ref: str,
    max_bytes: int,
    timeout: int,
) -> str | None:
    """HTTP(S) URL → 下载到 generated/{channel_id}/{file_id}{ext} → 建 FileRecord。"""
    try:
        async with httpx.AsyncClient(
            follow_redirects=True, timeout=timeout,
        ) as client:
            async with client.stream("GET", ref) as resp:
                if resp.status_code >= 400:
                    logger.warning(
                        "media_extract: url %s HTTP %d", ref, resp.status_code,
                    )
                    return None

                # size hint
                clen = resp.headers.get("content-length")
                if clen and clen.isdigit() and int(clen) > max_bytes:
                    logger.warning(
                        "media_extract: url %s declared size %s exceeds cap %d",
                        ref, clen, max_bytes,
                    )
                    return None

                content_type = (resp.headers.get("content-type") or "").split(";")[0].strip()
                ext = mimetypes.guess_extension(content_type) if content_type else ""
                ext = ext or Path(urlparse(ref).path).suffix or ""

                file_id = str(uuid.uuid4())
                gen_dir = resolve_data_dir() / "generated" / channel_id
                gen_dir.mkdir(parents=True, exist_ok=True)
                dst = gen_dir / f"{file_id}{ext}"
                if not dst.resolve().is_relative_to(gen_dir.resolve()):
                    logger.warning("media_extract: dst path escape blocked: %s", dst)
                    return None

                total = 0
                with open(dst, "wb") as fh:
                    async for chunk in resp.aiter_bytes(chunk_size=64 * 1024):
                        total += len(chunk)
                        if total > max_bytes:
                            fh.close()
                            dst.unlink(missing_ok=True)
                            logger.warning(
                                "media_extract: url %s body exceeds cap %d",
                                ref, max_bytes,
                            )
                            return None
                        fh.write(chunk)

                original_name = _safe_filename_from_url(ref, fallback_ext=ext)
                final_ctype = content_type or _guess_content_type(original_name)
                now = datetime.now(timezone.utc)

                record = FileRecord(
                    file_id=file_id,
                    channel_id=channel_id,
                    uploader_id=uploader_id,
                    original_path=str(dst),
                    original_filename=original_name,
                    content_type=final_ctype,
                    size_bytes=total,
                    status="ready",
                    uploaded_at=now,
                )
                session.add(record)
                await session.flush()
                logger.info(
                    "media_extract: url %s -> file_id=%s (%s, %d bytes)",
                    ref, file_id, final_ctype, total,
                )
                return file_id
    except (httpx.HTTPError, OSError) as exc:
        logger.warning("media_extract: url %s download failed: %s", ref, exc)
        return None


async def materialize_media_refs(
    session: AsyncSession,
    *,
    channel_id: str,
    uploader_id: str,
    refs: list[str],
) -> list[str]:
    """把 refs 逐个物化为 FileRecord，返回成功建出的 file_ids 列表。

    - 失败的单个 ref 只记日志，其他继续。
    - 调用方负责外层 session.commit / rollback。
    """
    if not refs:
        return []
    if not settings.media_extract_enabled:
        logger.info("media_extract: disabled via config, skipping %d refs", len(refs))
        return []

    max_bytes = int(settings.media_max_file_bytes)
    timeout = int(settings.media_download_timeout_seconds)

    out: list[str] = []
    for ref in refs:
        if _is_url(ref):
            fid = await _materialize_url(
                session,
                channel_id=channel_id,
                uploader_id=uploader_id,
                ref=ref,
                max_bytes=max_bytes,
                timeout=timeout,
            )
        else:
            fid = await _materialize_local(
                session,
                channel_id=channel_id,
                uploader_id=uploader_id,
                ref=ref,
                max_bytes=max_bytes,
            )
        if fid:
            out.append(fid)
    return out

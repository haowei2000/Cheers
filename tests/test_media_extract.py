"""MEDIA: 行抽取 + 物化 单元测试（feat/websocket-bot-media-transfer）."""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import Channel, FileRecord, User, Workspace
from app.services.openclaw_bridge import media_extract as me

# ============================================================================
# extract_media_refs（纯函数）
# ============================================================================

def test_extract_empty_content_returns_empty() -> None:
    r = me.extract_media_refs("")
    assert r.refs == []
    assert r.cleaned_content == ""


def test_extract_no_media_lines_leaves_content_unchanged() -> None:
    text = "hi there\nthis is a reply\nnothing to see"
    r = me.extract_media_refs(text)
    assert r.refs == []
    assert r.cleaned_content == text


def test_extract_single_path_ref_at_end() -> None:
    text = "这是你要的截图。\nMEDIA:/workspace/output/chart.png"
    r = me.extract_media_refs(text)
    assert r.refs == ["/workspace/output/chart.png"]
    assert r.cleaned_content == "这是你要的截图。"


def test_extract_single_url_ref() -> None:
    text = "报告好了。\nMEDIA:https://example.com/report.pdf"
    r = me.extract_media_refs(text)
    assert r.refs == ["https://example.com/report.pdf"]
    assert "MEDIA:" not in r.cleaned_content


def test_extract_multiple_refs_mixed() -> None:
    text = (
        "first\n"
        "MEDIA:/tmp/a.png\n"
        "middle line\n"
        "MEDIA:https://x.com/b.pdf\n"
        "end"
    )
    r = me.extract_media_refs(text)
    assert r.refs == ["/tmp/a.png", "https://x.com/b.pdf"]
    # 被抽掉的两行不应残留，中间连续空行压缩
    assert "MEDIA:" not in r.cleaned_content
    assert "first" in r.cleaned_content
    assert "middle line" in r.cleaned_content
    assert "end" in r.cleaned_content


def test_extract_rejects_leading_whitespace() -> None:
    """前导空格 → 不视为 MEDIA 行（OpenClaw 规范：必须行首）。"""
    text = "前言\n MEDIA:/tmp/a.png\n  MEDIA:/tmp/b.png\nend"
    r = me.extract_media_refs(text)
    assert r.refs == []
    # 整行保留（缩进版）
    assert "MEDIA:/tmp/a.png" in r.cleaned_content
    assert "MEDIA:/tmp/b.png" in r.cleaned_content


def test_extract_rejects_space_after_colon() -> None:
    """MEDIA: + 空格开头的值 → 不抽取（要求冒号后立刻是非空白字符）。"""
    text = "x\nMEDIA: /tmp/a.png\nend"
    r = me.extract_media_refs(text)
    assert r.refs == []
    assert "MEDIA: /tmp/a.png" in r.cleaned_content


def test_extract_ignores_inline_media_substring() -> None:
    """行中间出现 MEDIA: 不应被抽（必须行首）。"""
    text = "see MEDIA:/tmp/a.png in the middle"
    r = me.extract_media_refs(text)
    assert r.refs == []
    assert r.cleaned_content == text


def test_extract_respects_refs_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "media_max_refs_per_message", 2)
    text = "MEDIA:/a\nMEDIA:/b\nMEDIA:/c\nMEDIA:/d"
    r = me.extract_media_refs(text)
    assert r.refs == ["/a", "/b"]


# ============================================================================
# _materialize_local（真实文件复制）
# ============================================================================

async def _seed_channel(db_session: AsyncSession, *, ch_id: str, bot_id: str) -> None:
    ws_id = f"ws-{uuid.uuid4().hex[:8]}"
    db_session.add(Workspace(workspace_id=ws_id, name="WMedia"))
    db_session.add(Channel(channel_id=ch_id, workspace_id=ws_id, name="chmedia", type="public"))
    db_session.add(User(
        user_id=bot_id,
        username=f"u-{bot_id[-12:]}",
        password_hash="x",
        display_name="U",
        role="member",
    ))
    await db_session.commit()


@pytest.mark.asyncio
async def test_materialize_local_happy_path(
    db_session: AsyncSession, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """本地路径在 data_dir 内 → 复制到 generated/{channel_id}/，FileRecord 就位。"""
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "media_workspace_only", True)
    monkeypatch.setattr(settings, "media_extract_enabled", True)

    src = tmp_path / "chart.png"
    src.write_bytes(b"\x89PNG\r\n\x1a\npayload")

    ch_id = f"ch-{uuid.uuid4().hex[:8]}"
    bot_id = f"bot-{uuid.uuid4().hex[:8]}"
    await _seed_channel(db_session, ch_id=ch_id, bot_id=bot_id)

    fids = await me.materialize_media_refs(
        db_session, channel_id=ch_id, uploader_id=bot_id, refs=[str(src)],
    )
    await db_session.commit()

    assert len(fids) == 1
    rec = (await db_session.execute(
        select(FileRecord).where(FileRecord.file_id == fids[0])
    )).scalar_one()
    assert rec.channel_id == ch_id
    assert rec.uploader_id == bot_id
    assert rec.original_filename == "chart.png"
    assert rec.content_type == "image/png"
    assert rec.size_bytes == src.stat().st_size
    assert rec.status == "ready"
    # 物理文件确实被复制到 generated/{ch_id}/{file_id}.png
    dst = tmp_path / "generated" / ch_id / f"{fids[0]}.png"
    assert dst.exists()
    assert dst.read_bytes() == src.read_bytes()


@pytest.mark.asyncio
async def test_materialize_local_rejects_outside_workspace(
    db_session: AsyncSession, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """workspaceOnly=True 且路径不在任何允许根内 → 跳过、不建 FileRecord。"""
    monkeypatch.setattr(settings, "data_dir", str(tmp_path / "workspace"))
    monkeypatch.setattr(settings, "media_workspace_only", True)
    monkeypatch.setattr(settings, "media_allowed_dirs", "")
    monkeypatch.setattr(settings, "media_extract_enabled", True)

    outside = tmp_path / "outside.txt"
    outside.write_text("not allowed")

    ch_id = f"ch-{uuid.uuid4().hex[:8]}"
    bot_id = f"bot-{uuid.uuid4().hex[:8]}"
    await _seed_channel(db_session, ch_id=ch_id, bot_id=bot_id)

    fids = await me.materialize_media_refs(
        db_session, channel_id=ch_id, uploader_id=bot_id, refs=[str(outside)],
    )
    await db_session.commit()

    assert fids == []
    rows = (await db_session.execute(
        select(FileRecord).where(FileRecord.channel_id == ch_id)
    )).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_materialize_local_allows_extra_dirs(
    db_session: AsyncSession, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """media_allowed_dirs 额外白名单能放行 data_dir 以外的合法目录。"""
    extra_dir = tmp_path / "openclaw_workspace"
    extra_dir.mkdir()
    src = extra_dir / "doc.md"
    src.write_text("# hi")

    monkeypatch.setattr(settings, "data_dir", str(tmp_path / "data"))
    monkeypatch.setattr(settings, "media_workspace_only", True)
    monkeypatch.setattr(settings, "media_allowed_dirs", str(extra_dir))
    monkeypatch.setattr(settings, "media_extract_enabled", True)

    ch_id = f"ch-{uuid.uuid4().hex[:8]}"
    bot_id = f"bot-{uuid.uuid4().hex[:8]}"
    await _seed_channel(db_session, ch_id=ch_id, bot_id=bot_id)

    fids = await me.materialize_media_refs(
        db_session, channel_id=ch_id, uploader_id=bot_id, refs=[str(src)],
    )
    await db_session.commit()

    assert len(fids) == 1


@pytest.mark.asyncio
async def test_materialize_local_missing_file_skipped(
    db_session: AsyncSession, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "media_extract_enabled", True)

    ch_id = f"ch-{uuid.uuid4().hex[:8]}"
    bot_id = f"bot-{uuid.uuid4().hex[:8]}"
    await _seed_channel(db_session, ch_id=ch_id, bot_id=bot_id)

    fids = await me.materialize_media_refs(
        db_session, channel_id=ch_id, uploader_id=bot_id,
        refs=[str(tmp_path / "does-not-exist.png")],
    )
    await db_session.commit()
    assert fids == []


@pytest.mark.asyncio
async def test_materialize_local_rejects_oversize(
    db_session: AsyncSession, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "media_extract_enabled", True)
    monkeypatch.setattr(settings, "media_max_file_bytes", 10)

    src = tmp_path / "big.bin"
    src.write_bytes(b"0" * 100)

    ch_id = f"ch-{uuid.uuid4().hex[:8]}"
    bot_id = f"bot-{uuid.uuid4().hex[:8]}"
    await _seed_channel(db_session, ch_id=ch_id, bot_id=bot_id)

    fids = await me.materialize_media_refs(
        db_session, channel_id=ch_id, uploader_id=bot_id, refs=[str(src)],
    )
    await db_session.commit()
    assert fids == []


# ============================================================================
# materialize_media_refs 路由（URL vs 本地）+ 开关
# ============================================================================

@pytest.mark.asyncio
async def test_materialize_skips_when_disabled(
    db_session: AsyncSession, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "media_extract_enabled", False)
    fids = await me.materialize_media_refs(
        db_session, channel_id="c", uploader_id="b", refs=[str(tmp_path / "x")],
    )
    assert fids == []


@pytest.mark.asyncio
async def test_materialize_routes_url_refs_to_url_fn(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """http(s):// 开头的 ref 走 _materialize_url，本地 ref 走 _materialize_local。"""
    calls: dict[str, list[str]] = {"url": [], "local": []}

    async def _fake_url(session, *, channel_id, uploader_id, ref, max_bytes, timeout):
        calls["url"].append(ref)
        return f"fid-url-{len(calls['url'])}"

    async def _fake_local(session, *, channel_id, uploader_id, ref, max_bytes):
        calls["local"].append(ref)
        return f"fid-local-{len(calls['local'])}"

    monkeypatch.setattr(settings, "media_extract_enabled", True)
    monkeypatch.setattr(me, "_materialize_url", _fake_url)
    monkeypatch.setattr(me, "_materialize_local", _fake_local)

    fids = await me.materialize_media_refs(
        db_session,
        channel_id="c",
        uploader_id="b",
        refs=[
            "https://example.com/a.pdf",
            "/tmp/b.png",
            "http://example.com/c.jpg",
            "relative/d.md",
        ],
    )
    assert calls["url"] == ["https://example.com/a.pdf", "http://example.com/c.jpg"]
    assert calls["local"] == ["/tmp/b.png", "relative/d.md"]
    assert fids == ["fid-url-1", "fid-local-1", "fid-url-2", "fid-local-2"]


@pytest.mark.asyncio
async def test_materialize_continues_past_individual_failures(
    db_session: AsyncSession, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """一个 ref 失败不影响其他 ref 成功物化。"""
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "media_extract_enabled", True)
    monkeypatch.setattr(settings, "media_workspace_only", True)

    good = tmp_path / "good.txt"
    good.write_text("ok")
    missing = tmp_path / "missing.txt"  # 不创建

    ch_id = f"ch-{uuid.uuid4().hex[:8]}"
    bot_id = f"bot-{uuid.uuid4().hex[:8]}"
    await _seed_channel(db_session, ch_id=ch_id, bot_id=bot_id)

    fids = await me.materialize_media_refs(
        db_session, channel_id=ch_id, uploader_id=bot_id,
        refs=[str(missing), str(good)],
    )
    await db_session.commit()
    assert len(fids) == 1
    rec = (await db_session.execute(
        select(FileRecord).where(FileRecord.file_id == fids[0])
    )).scalar_one()
    assert rec.original_filename == "good.txt"

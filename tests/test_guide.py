"""Tests for test guide."""
from app.features.bot_runtime.adapters.help_catalog import find_help


def test_find_help_creation() -> None:
    """Covers test find help creation behavior."""
    content = find_help("怎么创建项目")
    assert content is not None
    assert "工作空间" in content
    assert "api/channels" in content or "创建项目" in content


def test_find_help_join() -> None:
    """Covers test find help join behavior."""
    content = find_help("怎么加入项目")
    assert content is not None
    assert "加入" in content


def test_find_help_openclaw() -> None:
    """Covers test find help openclaw behavior."""
    content = find_help("怎么接入 openclaw")
    assert content is not None
    assert "OpenClaw" in content or "bot" in content.lower()


def test_find_help_no_match_returns_none() -> None:
    """Covers test find help no match returns none behavior."""
    assert find_help("随便说点什么xyz") is None

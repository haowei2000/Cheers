"""Tests for test guide."""
from app.features.bot_runtime.adapters.help_catalog import (
    find_help,
    find_help_entries,
    get_help_context_for_llm,
)


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


def test_find_help_english_locale() -> None:
    content = find_help("how do I create a project?", locale="en")
    assert content is not None
    assert "workspace" in content.lower()


def test_find_help_no_match_returns_none() -> None:
    """Covers test find help no match returns none behavior."""
    assert find_help("随便说点什么xyz") is None


def test_help_context_is_ranked_by_question() -> None:
    context = get_help_context_for_llm("怎么创建项目", limit=1)

    assert "如何创建分组" in context
    assert "技术排查" not in context


def test_find_help_entries_respects_limit() -> None:
    entries = find_help_entries("怎么创建项目，怎么加入项目", limit=1)

    assert len(entries) == 1
    assert entries[0].title in {"如何创建分组", "如何加入分组"}

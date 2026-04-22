"""帮助索引（find_help）单测。"""
from app.services.guide.help_index import find_help


def test_find_help_creation() -> None:
    """「怎么创建项目」应匹配到创建项目帮助."""
    content = find_help("怎么创建项目")
    assert content is not None
    assert "工作空间" in content
    assert "api/channels" in content or "创建项目" in content


def test_find_help_join() -> None:
    """「怎么加入项目」应匹配到加入项目帮助."""
    content = find_help("怎么加入项目")
    assert content is not None
    assert "加入" in content


def test_find_help_openclaw() -> None:
    """「接入 openclaw」应匹配到 OpenClaw 接入帮助."""
    content = find_help("怎么接入 openclaw")
    assert content is not None
    assert "OpenClaw" in content or "bot" in content.lower()


def test_find_help_no_match_returns_none() -> None:
    """无关输入时 find_help 返回 None。"""
    assert find_help("随便说点什么xyz") is None

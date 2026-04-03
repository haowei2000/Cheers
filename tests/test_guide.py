"""引导 Bot 与帮助索引单测."""
import pytest

from app.services.adapters.base import AgentPayload
from app.services.guide.adapter import GuideBotAdapter
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


def test_find_help_no_match_returns_default_in_adapter() -> None:
    """无关输入时 find_help 返回 None，Adapter 返回默认引导."""
    assert find_help("随便说点什么xyz") is None


@pytest.mark.asyncio
async def test_guide_adapter_execute_returns_help() -> None:
    """引导适配器根据用户文本返回说明书摘要."""
    adapter = GuideBotAdapter()
    payload = AgentPayload(
        task_id="t1",
        channel_id="c1",
        trigger_message={"text": "怎么创建项目"},
        memory_context={},
    )
    resp = await adapter.execute(payload)
    assert resp.success
    assert "工作空间" in resp.content or "创建" in resp.content


@pytest.mark.asyncio
async def test_guide_adapter_execute_default_reply() -> None:
    """无匹配时返回默认引导语或澄清弹窗（rule-based clarify 可能触发 popup）."""
    adapter = GuideBotAdapter()
    payload = AgentPayload(
        task_id="t1",
        channel_id="c1",
        trigger_message={"text": "无关内容xyz"},
        memory_context={},
    )
    resp = await adapter.execute(payload)
    assert resp.success
    # force_rule=True 时无关输入也可能触发规则澄清弹窗，两者均为合法输出
    assert (
        "怎么创建项目" in resp.content
        or "说明书" in resp.content
        or "guide-clarify" in resp.content
    )


@pytest.mark.asyncio
async def test_guide_adapter_health_check() -> None:
    """引导 Bot 始终健康."""
    adapter = GuideBotAdapter()
    assert await adapter.health_check() is True

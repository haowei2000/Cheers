"""测试 UnifiedBuiltinBotAdapter 能否通过 update_anchor 工具正确更新锚点层。"""
import tempfile
from unittest.mock import AsyncMock, patch

import pytest

from app.adapters.base import AgentPayload
from app.adapters.unified_builtin import UnifiedBuiltinBotAdapter


def _payload(channel_id: str, text: str) -> AgentPayload:
    return AgentPayload(
        task_id="test-task-001",
        channel_id=channel_id,
        trigger_message={"user": "user-001", "text": text, "timestamp": ""},
        memory_context={"anchor": "", "decisions": "", "files_index": "", "recent": ""},
    )


@pytest.mark.asyncio
async def test_update_anchor_persists_content() -> None:
    """LLM 返回 update_anchor 工具调用时，锚点层应被写入 context store。"""
    channel_id = "test-ch-anchor-001"
    anchor_content = "项目目标：构建多智能体协作平台，2026 Q2 上线。"

    # LLM 第一轮返回 update_anchor 工具调用，第二轮返回最终文本
    llm_responses = iter([
        f'```tool-call\n{{"tool": "update_anchor", "args": {{"content": "{anchor_content}"}}}}\n```',
        "已为你更新项目锚点。",
    ])

    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        tmp_db = f.name

    with (
        patch("app.memory.manager._context_db_path", return_value=tmp_db),
        patch("app.memory.recent_update._context_db_path", return_value=tmp_db),
        patch(
            "app.adapters.unified_builtin._call_llm_messages",
            new=AsyncMock(side_effect=lambda msgs: next(llm_responses)),
        ),
    ):
        adapter = UnifiedBuiltinBotAdapter()
        resp = await adapter.execute(_payload(channel_id, "请把项目锚点更新为：" + anchor_content))

    assert resp.success is True
    assert "锚点" in resp.content or "已为你更新" in resp.content

    # 验证锚点层已持久化到 context store
    from app.memory.context_store import get_layer, init_context_db
    await init_context_db(tmp_db)
    stored = await get_layer(tmp_db, channel_id, "ANCHOR")
    assert stored == anchor_content, f"期望锚点内容 {anchor_content!r}，实际得到 {stored!r}"


@pytest.mark.asyncio
async def test_update_anchor_empty_content_returns_error() -> None:
    """update_anchor 传入空 content 时应返回错误而不崩溃。"""
    channel_id = "test-ch-anchor-002"

    llm_responses = iter([
        '```tool-call\n{"tool": "update_anchor", "args": {"content": ""}}\n```',
        "操作失败。",
    ])

    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        tmp_db = f.name

    with (
        patch("app.memory.manager._context_db_path", return_value=tmp_db),
        patch(
            "app.adapters.unified_builtin._call_llm_messages",
            new=AsyncMock(side_effect=lambda msgs: next(llm_responses)),
        ),
    ):
        adapter = UnifiedBuiltinBotAdapter()
        resp = await adapter.execute(_payload(channel_id, "清空锚点"))

    # 不应抛出异常，工具错误反馈给 LLM 后继续
    assert resp.success is True


@pytest.mark.asyncio
async def test_update_anchor_via_api(client, db_session) -> None:
    """通过 HTTP API 发送消息，触发 update_anchor，验证 context store 中锚点已更新。"""
    import asyncio
    import tempfile
    from app.db.models import AIModel, BotAccount, Channel, ChannelMembership, PromptTemplate, Workspace
    from app.guide.constants import GUIDE_BOT_ID

    ws = Workspace(workspace_id="anc0-0000-0000-0000-000000000001", name="AnchorWS")
    ch = Channel(
        channel_id="anc1-0000-0000-0000-000000000001",
        workspace_id=ws.workspace_id,
        name="anchor-test",
        type="public",
    )
    model = AIModel(
        model_id="anc-model-0001",
        name="anchor-test-model",
        provider="test",
        model_name="test",
        base_url="http://localhost",
        is_enabled=False,
        is_builtin=True,
        config={},
    )
    tpl = PromptTemplate(
        template_id="anc-tpl-0001",
        name="anchor-tpl",
        system_prompt="test",
        user_template="{{message}}",
        variables=["message"],
        is_builtin=False,
    )
    bot = BotAccount(
        bot_id=GUIDE_BOT_ID,
        username="channel bot",
        display_name="内置助手",
        model_id=model.model_id,
        template_id=tpl.template_id,
        status="online",
    )
    db_session.add_all([ws, ch, model, tpl, bot])
    db_session.add(ChannelMembership(
        channel_id=ch.channel_id,
        member_id=bot.bot_id,
        member_type="bot",
    ))
    await db_session.commit()

    anchor_text = "API 测试锚点内容 v1"
    llm_responses = iter([
        f'```tool-call\n{{"tool": "update_anchor", "args": {{"content": "{anchor_text}"}}}}\n```',
        "锚点已更新。",
    ])

    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        tmp_db = f.name

    with (
        patch("app.memory.manager._context_db_path", return_value=tmp_db),
        patch("app.memory.recent_update._context_db_path", return_value=tmp_db),
        patch(
            "app.adapters.unified_builtin._call_llm_messages",
            new=AsyncMock(side_effect=lambda msgs: next(llm_responses)),
        ),
    ):
        resp = await client.post(
            f"/api/channels/{ch.channel_id}/messages",
            json={
                "content": f"@channel bot 请更新项目锚点：{anchor_text}",
                "sender_id": "a0000000-0000-0000-0000-000000000001",
                "sender_type": "user",
            },
        )
        assert resp.status_code == 200
        await asyncio.sleep(0.3)

    # 验证 context store 中的锚点
    from app.memory.context_store import get_layer, init_context_db
    await init_context_db(tmp_db)
    stored = await get_layer(tmp_db, ch.channel_id, "ANCHOR")
    assert stored == anchor_text, f"期望 {anchor_text!r}，实际 {stored!r}"

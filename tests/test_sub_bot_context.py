"""测试子 Bot 上下文传递优化。"""
import pytest
from unittest.mock import AsyncMock, patch

from app.services.adapters.base import AgentPayload, AgentResponse
from app.services.adapters.unified_builtin import UnifiedBuiltinBotAdapter


@pytest.mark.asyncio
async def test_call_bot_passes_memory_context():
    """验证 call_bot 工具正确传递四层记忆给子 Bot。"""
    adapter = UnifiedBuiltinBotAdapter()
    
    # 模拟完整的四层记忆上下文
    memory_context = {
        "anchor": "项目目标：构建协作平台",
        "decisions": "决策 1: 使用 SQLite\n决策 2: 采用四层记忆架构",
        "files_index": "file-001: 需求文档.md - 系统需求规格说明",
        "recent": "用户 A: 怎么创建项目？\nBot: 点击左上角 + 号...",
    }
    
    payload = AgentPayload(
        task_id="test-task-001",
        channel_id="test-channel-001",
        trigger_message={
            "user": "user-001",
            "text": "请帮我分析这个项目",
            "timestamp": "2026-04-03T10:00:00Z",
        },
        memory_context=memory_context,
        attachments=[],
    )
    
    # Mock 子 Bot 的适配器
    mock_sub_adapter = AsyncMock()
    mock_sub_adapter.execute.return_value = AgentResponse(
        content="基于项目锚点，这是一个协作平台...",
        task_id="test-task-001",
        success=True,
    )
    
    # Mock 上下文中的必要依赖
    async def mock_adapter_factory(bot_id: str):
        return mock_sub_adapter
    
    async def mock_pre_create_bot_msg(bot_id, task_id):
        from app.db.models import Message
        msg = Message(msg_id="msg-001")
        return msg
    
    async def mock_finalize_bot_msg(msg, content):
        pass
    
    def mock_make_stream_token_cb(msg_id):
        async def cb(delta: str):
            pass
        return cb
    
    # 执行测试
    with patch("app.services.adapters.unified_builtin._get_llm_config", return_value=None):
        # 模拟 tool_ctx，包含 call_bot 需要的上下文
        tool_ctx = {
            "channel_id": "test-channel-001",
            "bot_id_by_username": {"codebot": "bot-code-001"},
            "adapter_factory": mock_adapter_factory,
            "pre_create_bot_msg": mock_pre_create_bot_msg,
            "finalize_bot_msg": mock_finalize_bot_msg,
            "make_stream_token_cb": mock_make_stream_token_cb,
            "memory": memory_context,  # 四层记忆
            "task_id": "test-task-001",
            "sender_id": "user-001",
            "attachments": [],
            "_db_session": None,
        }
        
        # 直接调用 call_bot 工具
        from langchain_core.tools import tool as _tool_decorator
        from app.services.adapters.unified_builtin import _make_tools
        
        tools = _make_tools(tool_ctx)
        call_bot_tool = next(t for t in tools if t.name == "call_bot")
        
        result = await call_bot_tool.ainvoke({"username": "codebot", "message": "请审查代码"})
        
        # 验证子 Bot 被调用
        assert mock_sub_adapter.execute.called
        call_args = mock_sub_adapter.execute.call_args[0][0]
        
        # 验证四层记忆被正确传递给子 Bot
        assert isinstance(call_args, AgentPayload)
        assert call_args.memory_context == memory_context
        assert call_args.memory_context["anchor"] == "项目目标：构建协作平台"
        assert call_args.memory_context["decisions"] == "决策 1: 使用 SQLite\n决策 2: 采用四层记忆架构"
        assert call_args.memory_context["files_index"] == "file-001: 需求文档.md - 系统需求规格说明"
        assert call_args.memory_context["recent"] == "用户 A: 怎么创建项目？\nBot: 点击左上角 + 号..."
        
        # 验证返回结果包含子 Bot 的回复
        assert "@codebot 回复：" in result
        assert "基于项目锚点" in result


@pytest.mark.asyncio
async def test_llm_bot_receives_memory_as_template_vars():
    """验证 LLM Bot 将记忆上下文注入为模板变量。"""
    from app.services.adapters.llm_bot import LLMBotAdapter
    from app.db.models import BotAccount, AIModel, PromptTemplate
    
    # 创建测试 Bot（使用记忆变量的模板）
    model = AIModel(
        model_id="model-test",
        name="Test Model",
        provider="openai",
        model_name="gpt-4o",
        base_url="https://api.openai.com/v1",
        api_key="test-key",
    )
    
    template = PromptTemplate(
        template_id="template-test",
        name="Test Template",
        system_prompt="你是一个专业的助手",
        user_template="项目锚点：{{anchor}}\n\n决策记录：{{decisions}}\n\n文件索引：{{files_index}}\n\n近期动态：{{recent}}\n\n用户问题：{{message}}",
        variables=["message"],
    )
    
    bot = BotAccount(
        bot_id="bot-test",
        username="testbot",
        ai_model=model,
        prompt_template=template,
    )
    
    adapter = LLMBotAdapter(bot)
    
    # 准备带四层记忆的 payload
    memory_context = {
        "anchor": "锚点内容",
        "decisions": "决策内容",
        "files_index": "文件索引内容",
        "recent": "近期动态内容",
    }
    
    payload = AgentPayload(
        task_id="test-task",
        channel_id="test-channel",
        trigger_message={"user": "user-001", "text": "你好", "timestamp": ""},
        memory_context=memory_context,
        attachments=[],
    )
    
    # 验证_build_messages 会正确注入记忆变量
    messages = adapter._build_messages("你好", {
        "anchor": "锚点内容",
        "decisions": "决策内容",
        "files_index": "文件索引内容",
        "recent": "近期动态内容",
    })
    
    assert len(messages) == 2
    assert messages[0]["role"] == "system"
    assert messages[0]["content"] == "你是一个专业的助手"
    
    user_content = messages[1]["content"]
    assert "项目锚点：锚点内容" in user_content
    assert "决策记录：决策内容" in user_content
    assert "文件索引：文件索引内容" in user_content
    assert "近期动态：近期动态内容" in user_content
    assert "用户问题：你好" in user_content

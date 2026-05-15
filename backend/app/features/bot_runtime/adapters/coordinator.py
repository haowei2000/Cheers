"""@channel bot 适配器：内置统一 Bot（LangChain Agent + 工具集）。LangChain Agent + 工具集。

工具：
  call_bot        — @某Bot，将子任务委托给频道内专业 Bot
  call_user       — 主动 @某位用户，可附带选择题等待其回答（合并原 ask_user）
  update_anchor   — 更新四层记忆中的锚点层
  update_decision — 更新四层记忆中的决策层
  update_progress — 更新四层记忆中的进度层
  create_file     — 将内容保存为 MD 文件，返回下载链接
  read_file       — 读取频道内已上传文件的完整正文
  web_fetch       — 获取网页内容，用于读取外部文档或链接
  web_search      — 网页搜索，用于查找当前信息或研究主题

Agent：使用 LangChain bind_tools + 手动 agent loop，
       通过 OpenAI function calling API 实现结构化工具调用。
"""

import json
import logging
import re
from typing import Any, cast
from xml.sax.saxutils import escape, quoteattr

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

from app.features.bot_runtime.adapters.base import AgentPayload, BotAdapter
from app.features.bot_runtime.adapters.help_catalog import (
    build_help_content_with_form,
    get_help_context_for_llm,
)
from app.features.memory.prompt_xml import MEMORY_LAYER_FIELDS, render_channel_memory_xml
from app.services.admin.settings_store import get_provider_for_scope

logger = logging.getLogger("app.features.bot_runtime.adapters.channel_bot")

MAX_LOOP_ITERATIONS = 8
HISTORY_MSG_COUNT = 30  # Maximum number of history messages injected into the LLM.
HISTORY_MSG_MAX_CHARS = 600  # Maximum characters retained from each history message.
_CLARIFY_PREFIX = "@channel bot 澄清回答："

_DEFAULT_REPLY = (
    "您可以说：怎么创建项目、怎么加入项目、怎么接入外部 Agent、怎么发消息、"
    "左边没有项目、@ 没反应、怎么安装、报错排查 等，我会根据说明书为您引导。"
    "也可以直接问项目相关问题，我会结合频道上下文回答。"
)


_MEMORY_XML_FIELDS = MEMORY_LAYER_FIELDS


def _xml_text(value: Any) -> str:
    return escape(str(value or ""), {"\r": "&#13;"})


def _xml_attr(value: Any) -> str:
    return quoteattr(str(value or ""))


def _format_call_bot_xml_prompt(*, username: str, message: str, run_ctx: Any) -> str:
    """Build the synthetic child-Bot prompt as one XML document.

    The receiving adapter sends this document as-is. That keeps delegated
    tasks structurally separate from channel memory and avoids the old
    ``{{memory}}\n\n{{message}}`` soup when the parent Bot calls ``call_bot``.
    """
    from datetime import datetime, timezone

    memory = getattr(run_ctx, "memory_context", None) or {}
    original_question = (
        getattr(run_ctx, "original_question", None)
        or getattr(run_ctx, "trigger_content", None)
        or ""
    )
    attachments = getattr(run_ctx, "attachments", None) or []
    topic_chain = getattr(run_ctx, "topic_chain", None) or []
    child_replies = getattr(run_ctx, "child_replies", None) or []
    trigger_msg = getattr(run_ctx, "trigger_msg", None)
    trigger_msg_id = getattr(trigger_msg, "msg_id", "") if trigger_msg is not None else ""

    lines: list[str] = [
        '<agentnexus_subbot_request version="1">',
        "  <routing>",
        f"    <target_bot username={_xml_attr(username)} />",
        f"    <channel id={_xml_attr(getattr(run_ctx, 'channel_id', ''))}>{_xml_text(getattr(run_ctx, 'channel_name', ''))}</channel>",
        f"    <sender id={_xml_attr(getattr(trigger_msg, 'sender_id', '') if trigger_msg is not None else '')}>{_xml_text(getattr(run_ctx, 'sender_name', ''))}</sender>",
        f"    <root_task_id>{_xml_text(getattr(run_ctx, 'root_task_id', ''))}</root_task_id>",
        f"    <trigger_msg_id>{_xml_text(trigger_msg_id)}</trigger_msg_id>",
        f"    <generated_at>{datetime.now(timezone.utc).isoformat()}</generated_at>",
        "  </routing>",
        f"  <delegated_task>{_xml_text(message)}</delegated_task>",
    ]
    if original_question and original_question != message:
        lines.extend([
            f"  <original_user_input>{_xml_text(original_question)}</original_user_input>",
        ])

    lines.append("  <channel_memory>")
    for key, label in _MEMORY_XML_FIELDS:
        content = (memory.get(key) or "").strip() if isinstance(memory, dict) else ""
        if not content:
            continue
        lines.append(f"    <layer name={_xml_attr(key)} label={_xml_attr(label)}>{_xml_text(content)}</layer>")
    lines.append("  </channel_memory>")

    if attachments:
        lines.append("  <attachments>")
        for attachment in attachments:
            if not isinstance(attachment, dict):
                continue
            attrs = [
                f"file_id={_xml_attr(attachment.get('file_id', ''))}",
                f"filename={_xml_attr(attachment.get('filename') or attachment.get('original_filename') or '')}",
                f"content_type={_xml_attr(attachment.get('content_type', ''))}",
            ]
            lines.append(f"    <attachment {' '.join(attrs)}>")
            if attachment.get("summary"):
                lines.append(f"      <summary>{_xml_text(attachment.get('summary'))}</summary>")
            if attachment.get("preview_url"):
                lines.append(f"      <preview_url>{_xml_text(attachment.get('preview_url'))}</preview_url>")
            lines.append("    </attachment>")
        lines.append("  </attachments>")

    if topic_chain or child_replies:
        lines.append("  <thread_context>")
        if topic_chain:
            lines.append(f"    <topic_chain>{_xml_text(json.dumps(topic_chain, ensure_ascii=False))}</topic_chain>")
        if child_replies:
            lines.append(f"    <child_replies>{_xml_text(json.dumps(child_replies, ensure_ascii=False))}</child_replies>")
        lines.append("  </thread_context>")

    lines.extend([
        "  <response_contract>",
        "    <item>Only handle the delegated_task unless original_user_input is needed for context.</item>",
        "    <item>Use channel_memory as supporting context, not as the task itself.</item>",
        "    <item>If you produce files, return them through AgentNexus attachments when available.</item>",
        "  </response_contract>",
        "</agentnexus_subbot_request>",
    ])
    return "\n".join(lines)


# LLM configuration.


def _get_llm_config() -> dict | None:
    """优先 channel_bot，依次回退 orchestrator / system_llm，最后回退 helper_llm_* 环境变量。"""
    for scope in ("channel_bot", "orchestrator", "system_llm"):
        cfg = get_provider_for_scope(scope)
        if cfg and cfg.get("base_url") and cfg.get("model"):
            return cfg

    # Fall back to helper_llm_* environment variables when admin settings are absent.
    from app.config import settings

    if settings.helper_llm_base_url and settings.helper_llm_model:
        return {
            "base_url": settings.helper_llm_base_url.rstrip("/"),
            "model": settings.helper_llm_model,
            "api_key": settings.helper_llm_api_key or "none",
            "temperature": float(settings.helper_llm_temperature),
            "max_tokens": int(settings.helper_llm_max_tokens),
        }
    return None


def _make_llm(cfg: dict) -> ChatOpenAI:
    """从配置构建 ChatOpenAI 实例。"""
    kwargs: dict[str, Any] = {
        "base_url": cfg["base_url"].rstrip("/"),
        "api_key": cfg.get("api_key") or "none",
        "model": cfg["model"],
        "temperature": float(cfg.get("temperature", 0.7)),
        "max_tokens": min(int(cfg.get("max_tokens") or 2000), 65536),
        "streaming": True,
        "timeout": float(cfg.get("timeout", 600)),
    }
    extra_headers = cfg.get("extra_headers")
    if isinstance(extra_headers, dict):
        kwargs["default_headers"] = {str(k): str(v) for k, v in extra_headers.items()}
    return ChatOpenAI(**kwargs)


# Tool labels.


def _tool_label(tool_name: str, args: dict) -> str:
    """Human-readable label for a tool call notification."""
    args = args or {}
    match tool_name:
        case "call_bot":
            return f"调用 @{args.get('username', '?')}"
        case "update_anchor":
            return "更新项目锚点"
        case "update_decision":
            return "记录决策"
        case "update_progress":
            return "更新项目进度"
        case "call_user":
            return f"呼叫 @{args.get('username', '?')}"
        case "create_file":
            filename = args.get("filename") or "?"
            return f"创建文件 {filename}.md"
        case "read_file":
            file_id = args.get("file_id") or "?"
            preview = (file_id[:8] + "…") if len(file_id) > 8 else file_id
            return f"读取文件 {preview}"
        case "web_fetch":
            url = args.get("url") or "?"
            suffix = "..." if len(url) > 50 else ""
            return f"获取网页：{url[:50]}{suffix}"
        case "web_search":
            query = args.get("query") or "?"
            suffix = "..." if len(query) > 40 else ""
            return f"搜索：{query[:40]}{suffix}"
        case _:
            return tool_name


# Tool factories.


def _make_tools(ctx: dict) -> list:
    """创建绑定了执行上下文的工具列表。"""

    @tool
    async def update_anchor(content: str) -> str:
        """更新项目锚点层（覆盖写入）。用于持久化项目目标、范围、核心约束等关键信息。

        Args:
            content: 完整的新锚点内容（覆盖写入）
        """
        if not content.strip():
            return "错误：content 不能为空"
        from app.features.memory.manager import save_layer

        await save_layer(ctx["channel_id"], "anchor", content.strip())
        logger.info(
            "channel_bot[tool]: update_anchor channel=%s len=%d",
            ctx["channel_id"],
            len(content),
        )
        return "已更新项目锚点"

    @tool
    async def update_progress(content: str) -> str:
        """更新项目进度层（覆盖写入）。用于记录已完成事项、当前状态、下一步计划。

        Args:
            content: 当前进度、已完成事项、下一步计划（覆盖写入）
        """
        if not content.strip():
            return "错误：content 不能为空"
        from app.features.memory.manager import save_layer

        await save_layer(ctx["channel_id"], "progress", content.strip())
        logger.info(
            "channel_bot[tool]: update_progress channel=%s len=%d",
            ctx["channel_id"],
            len(content),
        )
        return "已更新项目进度"

    @tool
    async def update_decision(content: str) -> str:
        """记录重要决策到决策层（覆盖写入）。用于持久化技术选型、方案确认等关键决策。

        Args:
            content: 决策内容（覆盖写入）
        """
        if not content.strip():
            return "错误：content 不能为空"
        from app.features.memory.manager import save_layer

        await save_layer(ctx["channel_id"], "decisions", content.strip())
        logger.info(
            "channel_bot[tool]: update_decision channel=%s len=%d",
            ctx["channel_id"],
            len(content),
        )
        return "已更新决策记录"

    @tool
    async def call_bot(username: str, message: str) -> str:
        """调用频道内指定专业 Bot 处理子任务，结果会广播到频道并反馈到对话中。

        Args:
            username: Bot 用户名（不含 @ 符号）
            message: 发给该 Bot 的任务描述
        """
        from app.features.bot_runtime.pipeline.bot import Capabilities, dispatch_one

        username = username.strip().lstrip("@")
        message = message.strip()
        if not username or not message:
            return "错误：需要提供 username 和 message"

        run_ctx = ctx.get("_run_ctx")
        if run_ctx is None:
            return "错误：_run_ctx 未注入（内部错误）"

        bot_id = run_ctx.bot_id_by_username.get(username)
        if bot_id is None:
            return f"错误：频道内没有 @{username}，可用 Bot：{list(run_ctx.bot_id_by_username.keys())}"

        logger.debug(
            "channel_bot[tool]: call_bot @%s message(%d chars):\n%s",
            username,
            len(message),
            message,
        )
        delegated_prompt = _format_call_bot_xml_prompt(
            username=username,
            message=message,
            run_ctx=run_ctx,
        )
        try:
            resp = await dispatch_one(
                run_ctx,
                bot_id,
                capabilities=Capabilities.regular(),
                trigger_text_override=delegated_prompt,
                skip_system_prompt=True,
                delegated_task_xml=True,
                skip_attachment_error=True,
            )
            if resp is None:
                return f"@{username} 调用失败（异步派发或错误）"
            result = resp.content if resp.success else (resp.error_message or "Bot 执行出错")
            logger.info(
                "channel_bot[tool]: call_bot @%s completed channel=%s",
                username,
                run_ctx.channel_id,
            )
            return f"@{username} 回复：\n{result}"
        except Exception as e:
            logger.exception("channel_bot[tool]: call_bot @%s failed: %s", username, e)
            return f"@{username} 调用出错：{e}"

    @tool(return_direct=True)
    async def call_user(
        username: str,
        message: str,
        options: list[str] | str | None = None,
        allow_multiple: bool = False,
        allow_manual: bool = False,
        manual_label: str = "其他（手动输入）",
        manual_placeholder: str = "请输入您的回答...",
    ) -> str:
        """主动 @某位用户，向其发送消息或提出选择题，Agent 立即暂停等待其回应。

        仅通知时：填 username 和 message，不填 options。
        向用户提问时：同时填写 options（至少 2 个），将展示选择题 UI 并等待回答。

        Args:
            username: 用户名（不含 @ 符号，从对话历史中获取）
            message: 发给该用户的消息或问题描述
            options: 选项列表（至少 2 个）；可传列表或 JSON 字符串；留空则仅发送通知消息
            allow_multiple: 是否允许多选，默认 False（仅 options 不为空时生效）
            allow_manual: 是否允许手动输入，默认 False
            manual_label: 手动输入选项的显示标签
            manual_placeholder: 手动输入框的占位提示文字
        """
        username = (username or "").strip().lstrip("@")
        message = (message or "").strip()
        if not username or not message:
            return "错误：需要提供 username 和 message"

        # Be tolerant of options arriving as a JSON string.
        if isinstance(options, str) and options.strip().startswith("["):
            try:
                parsed = json.loads(options)
                if isinstance(parsed, list):
                    options = [str(o) for o in parsed]
            except (json.JSONDecodeError, TypeError):
                pass
        elif isinstance(options, str) and options.strip():
            # Accept a single string option for robustness, though it is not recommended.
            options = [options.strip()]

        mention_prefix = f"@{username} {message}"

        if not options:
            # Mention-only notification without a multiple-choice question.
            return mention_prefix

        if len(options) < 2:
            return "错误：options 至少需要 2 个选项"

        clarify_schema = {
            "title": message,
            "skip_policy": "allow",
            "questions": [
                {
                    "id": "q0",
                    "prompt": message,
                    "allow_multiple": allow_multiple,
                    "options": [{"id": f"a{i}", "label": str(opt)} for i, opt in enumerate(options)],
                    "other_enabled": allow_manual,
                    "other_label": manual_label or "其他（手动输入）",
                    "other_placeholder": manual_placeholder or "请输入您的回答...",
                }
            ],
        }
        clarify_block = "```helper-clarify\n" + json.dumps(clarify_schema, ensure_ascii=False) + "\n```"
        return f"{mention_prefix}\n\n{clarify_block}"

    @tool
    async def create_file(filename: str, content: str) -> str:
        """将内容保存为 Markdown 文件并返回下载链接。

        Args:
            filename: 文件名（不含扩展名）
            content: 文件的完整 Markdown 内容
        """
        import uuid
        from datetime import datetime, timezone
        from pathlib import Path

        safe_name = re.sub(r"[^\w\-. ]", "_", filename.strip()) or "output"
        body = content.strip()
        if not body:
            return "错误：content 不能为空"

        from app.config import settings
        from app.db.models import FileRecord
        from app.services.file_retention import file_expires_at

        file_id = str(uuid.uuid4())
        channel_id = ctx["channel_id"]

        base = Path(settings.data_dir)
        if not base.is_absolute():
            base = Path(__file__).resolve().parent.parent.parent / settings.data_dir
        gen_dir = base / "generated" / channel_id
        gen_dir.mkdir(parents=True, exist_ok=True)

        md_path = gen_dir / f"{file_id}.md"
        md_path.write_text(body, encoding="utf-8")

        original_filename = f"{safe_name}.md"
        now = datetime.now(timezone.utc)

        record = FileRecord(
            file_id=file_id,
            channel_id=channel_id,
            uploader_id=ctx.get("sender_id") or "system",
            original_path=str(md_path),
            original_filename=original_filename,
            content_type="text/markdown",
            size_bytes=len(body.encode("utf-8")),
            md_path=str(md_path),
            status="ready",
            uploaded_at=now,
            converted_at=now,
            expires_at=file_expires_at(now),
        )
        db_session = ctx.get("_db_session")
        if db_session:
            db_session.add(record)
            await db_session.flush()
        else:
            from app.db.session import async_session_factory

            async with async_session_factory() as s:
                s.add(record)
                await s.commit()

        preview_url = f"/api/v1/files/{file_id}/preview"
        logger.info(
            "channel_bot[tool]: create_file %s channel=%s",
            original_filename,
            channel_id,
        )

        # Collect file_ids so they can be attached to the final bot reply.
        ctx.setdefault("_created_file_ids", []).append(file_id)

        return f"文件已创建：[{original_filename}]({preview_url})\n\n预览链接：`{preview_url}`"

    @tool
    async def read_file(file_id: str) -> str:
        """读取频道内已上传文件的完整正文内容。
        使用场景：用户消息中引用了某文件，或文件索引中列出了文件，需要查看具体内容时调用。
        可从「=== 项目记忆 ===」的「资料索引」部分找到 file_id。

        Args:
            file_id: 文件的唯一 ID（形如 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx）
        """
        db_session = ctx.get("_db_session")
        if not db_session:
            return "错误：数据库会话未注入（内部错误）"

        from app.services.file_processor.service import FileFlowError, FilePipelineService

        try:
            svc = FilePipelineService()
            results = await svc.prepare_attachments(
                db_session,
                channel_id=ctx["channel_id"],
                file_ids=[file_id.strip()],
            )
        except FileFlowError as exc:
            return f"读取文件失败：{exc.detail}"
        except Exception as exc:
            logger.exception("channel_bot[tool]: read_file error file_id=%s", file_id)
            return f"读取文件出错：{exc}"

        if not results:
            return f"未找到 file_id={file_id!r} 的文件，请检查文件索引中的 file_id 是否正确"

        att = results[0]
        if att.get("is_image") == "true":
            return f"文件「{att.get('filename')}」是图片，请直接查看图片附件，无需读取文本。"

        parts = [f"=== 文件: {att.get('filename') or file_id} ==="]
        if att.get("summary"):
            parts.append(f"摘要: {att['summary']}")
        content = (att.get("content") or "").strip()
        if content:
            parts.append("正文:")
            parts.append(content)
            if att.get("truncated") == "true":
                parts.append("（注：文件内容已按长度限制截断，若需完整内容请联系上传者。）")
        else:
            parts.append("（文件内容为空或无法解析文本。）")
        return "\n".join(parts)

    @tool
    async def create_todo(content: str, assignee_username: str | None = None) -> str:
        """在当前频道创建一个待办事项 (Todo) 并可选地指派给某人或某个Bot。

        Args:
            content: 待办事项的内容描述。
            assignee_username: 可选，指派给某人的用户名（不含@），如果为空则不指派。
        """
        db_session = ctx.get("_db_session")
        if not db_session:
            return "错误：数据库会话未注入"

        channel_id = ctx["channel_id"]
        creator_id = ctx.get("_bot_id") or "system"
        creator_type = "bot"

        assignee_id = None
        assignee_type = None

        if assignee_username:
            username = assignee_username.strip().lstrip("@")
            from sqlalchemy import select

            from app.db.models import BotAccount, TodoItem, User

            stmt = select(User).where(User.username == username)
            user = (await db_session.execute(stmt)).scalars().first()
            if user:
                assignee_id = user.user_id
                assignee_type = "user"
            else:
                stmt = select(BotAccount).where(BotAccount.username == username)
                bot = (await db_session.execute(stmt)).scalars().first()
                if bot:
                    assignee_id = bot.bot_id
                    assignee_type = "bot"
                else:
                    return f"错误：找不到名为 {username} 的用户或Bot。"

        todo = TodoItem(
            channel_id=channel_id,
            creator_id=creator_id,
            creator_type=creator_type,
            assignee_id=assignee_id,
            assignee_type=assignee_type,
            content=content,
            status="pending",
        )
        db_session.add(todo)
        await db_session.commit()
        return "成功创建待办事项！"

    @tool
    async def list_todos() -> str:
        """列出当前频道所有待办事项，返回编号、状态、内容和指派人。"""
        db_session = ctx.get("_db_session")
        if not db_session:
            return "错误：数据库会话未注入"
        from sqlalchemy import select

        from app.db.models import TodoItem

        result = await db_session.execute(
            select(TodoItem).where(TodoItem.channel_id == ctx["channel_id"]).order_by(TodoItem.created_at)
        )
        todos = result.scalars().all()
        if not todos:
            return "当前频道没有待办事项。"
        lines = []
        for i, t in enumerate(todos, 1):
            status = "✅" if t.status == "completed" else "⬜"
            assignee = f"（指派给：{t.assignee_id}）" if t.assignee_id else ""
            lines.append(f"{i}. {status} {t.content}{assignee}")
        return "\n".join(lines)

    @tool
    async def update_todo(
        content_keyword: str,
        new_content: str | None = None,
        status: str | None = None,
        assignee_username: str | None = None,
    ) -> str:
        """修改当前频道中匹配关键词的待办事项。

        Args:
            content_keyword: 用于定位待办的关键词（与待办内容做子串匹配）。
            new_content: 可选，新的内容文本。
            status: 可选，新状态，"pending" 或 "completed"。
            assignee_username: 可选，重新指派给某人的用户名（不含@），传空字符串可清除指派。
        """
        db_session = ctx.get("_db_session")
        if not db_session:
            return "错误：数据库会话未注入"
        from sqlalchemy import select

        from app.db.models import BotAccount, TodoItem, User

        result = await db_session.execute(
            select(TodoItem).where(
                TodoItem.channel_id == ctx["channel_id"],
                TodoItem.content.ilike(f"%{content_keyword}%"),
            )
        )
        matches = result.scalars().all()
        if not matches:
            return f"错误：找不到包含'{content_keyword}'的待办事项。"
        if len(matches) > 1:
            preview = "、".join(f"'{t.content}'" for t in matches[:5])
            return f"错误：关键词'{content_keyword}'匹配到多条（{preview}），请提供更精确的关键词。"
        todo = matches[0]
        if new_content is not None:
            todo.content = new_content
        if status is not None:
            if status not in ("pending", "completed"):
                return "错误：status 只能是 'pending' 或 'completed'。"
            todo.status = status
        if assignee_username is not None:
            if assignee_username == "":
                todo.assignee_id = None
                todo.assignee_type = None
            else:
                username = assignee_username.strip().lstrip("@")
                stmt = select(User).where(User.username == username)
                user = (await db_session.execute(stmt)).scalars().first()
                if user:
                    todo.assignee_id = user.user_id
                    todo.assignee_type = "user"
                else:
                    stmt = select(BotAccount).where(BotAccount.username == username)
                    bot = (await db_session.execute(stmt)).scalars().first()
                    if bot:
                        todo.assignee_id = bot.bot_id
                        todo.assignee_type = "bot"
                    else:
                        return f"错误：找不到名为 {username} 的用户或Bot。"
        await db_session.commit()
        return f"成功更新待办事项：'{todo.content}'"

    @tool
    async def delete_todo(content_keyword: str) -> str:
        """删除当前频道中匹配关键词的待办事项。

        Args:
            content_keyword: 用于定位待办的关键词（与待办内容做子串匹配）。
        """
        db_session = ctx.get("_db_session")
        if not db_session:
            return "错误：数据库会话未注入"
        from sqlalchemy import select

        from app.db.models import TodoItem

        result = await db_session.execute(
            select(TodoItem).where(
                TodoItem.channel_id == ctx["channel_id"],
                TodoItem.content.ilike(f"%{content_keyword}%"),
            )
        )
        matches = result.scalars().all()
        if not matches:
            return f"错误：找不到包含'{content_keyword}'的待办事项。"
        if len(matches) > 1:
            preview = "、".join(f"'{t.content}'" for t in matches[:5])
            return f"错误：关键词'{content_keyword}'匹配到多条（{preview}），请提供更精确的关键词。"
        todo = matches[0]
        content = todo.content
        await db_session.delete(todo)
        await db_session.commit()
        return f"成功删除待办事项：'{content}'"

    @tool
    async def web_fetch(url: str) -> str:
        """Fetch and extract text content from a URL. Use when user references a webpage,
        shares a link, or you need to read external documentation/articles.

        Args:
            url: The URL to fetch (must start with http:// or https://)
        """
        from app.tools.web import web_fetch as do_web_fetch

        result = await do_web_fetch(url)
        logger.info("channel_bot[tool]: web_fetch url=%s len=%d", url[:80], len(result))
        return result

    @tool
    async def web_search(query: str, num_results: int = 5) -> str:
        """Search the web for information. Use when you need current information not in
        your knowledge base, or to research topics, find documentation, or verify facts.

        Args:
            query: Search query string (be specific for better results)
            num_results: Number of results to return (1-10, default 5)
        """
        from app.tools.web import web_search_formatted

        result = await web_search_formatted(query, num_results)
        logger.info("channel_bot[tool]: web_search query='%s' num=%d", query, num_results)
        return result

    return [
        update_anchor,
        update_progress,
        update_decision,
        call_bot,
        call_user,
        create_file,
        read_file,
        create_todo,
        list_todos,
        update_todo,
        delete_todo,
        web_fetch,
        web_search,
    ]


# Attachment handling.


def _build_file_refs_note(attachments: list[dict[str, str]] | None) -> str:
    """为文档附件生成简短的文件引用提示（不注入正文，Agent 按需调用 read_file 工具读取）。"""
    if not attachments:
        return ""
    lines = ["[本次消息关联以下文件，已登记到文件索引，如需查看内容请调用 read_file 工具]"]
    for att in attachments:
        fname = att.get("filename") or att.get("file_id") or "unknown"
        fid = att.get("file_id") or ""
        summary = (att.get("summary") or "").strip()
        line = f"- {fname}（file_id: `{fid}`）"
        if summary:
            line += f" — {summary[:80]}{'…' if len(summary) > 80 else ''}"
        lines.append(line)
    return "\n".join(lines)


def _build_vision_content(user_text: str, attachments: list[dict[str, str]] | None) -> list[dict]:
    """将文本和图片附件构建为 OpenAI Vision 格式的多模态 content 数组。"""
    parts: list[dict] = [{"type": "text", "text": user_text}]
    for att in attachments or []:
        if att.get("is_image") != "true":
            continue
        b64 = att.get("image_b64", "")
        if not b64:
            continue
        mime = att.get("content_type") or "image/jpeg"
        parts.append(
            {
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{b64}"},
            }
        )
    return parts


def _build_attachment_fallback_reply(user_text: str, attachments: list[dict[str, str]] | None) -> str:
    """LLM 不可用时，基于已解析的附件内容给出保底回答。"""
    if not attachments:
        return ""
    normalized = (user_text or "").lower()
    wants_summary = any(kw in normalized for kw in ("概括", "摘要", "总结", "概述", "summary", "summar"))
    sections = ["当前 LLM 服务暂时不可用，但我已经成功读取了上传文件内容。"]
    for index, attachment in enumerate(attachments, start=1):
        filename = attachment.get("filename") or attachment.get("file_id") or f"文件 {index}"
        summary = (attachment.get("summary") or "").strip()
        content = (attachment.get("content") or "").strip()
        excerpt = content[:280].strip()
        if len(content) > 280:
            excerpt += "..."
        sections.append(f"### 文件 {index}: {filename}")
        if wants_summary:
            sections.append("基于已解析文本的概括：")
            if summary:
                sections.append(summary)
            elif excerpt:
                sections.append(f"- {excerpt}")
            else:
                sections.append("- 文件已读取，但暂时没有可提取的文本内容。")
        else:
            if summary:
                sections.append("我先提取出文件的关键内容：")
                sections.append(summary)
            elif excerpt:
                sections.append("我先提取出文件的关键片段：")
                sections.append(f"- {excerpt}")
            else:
                sections.append("文件已读取，但暂时没有可提取的文本内容。")
    sections.append("如果你配置好可用的 LLM 服务后再次提问，我会在完整上下文上继续给出更深入的回答。")
    return "\n\n".join(part for part in sections if part).strip()


# History loading.

_UI_BLOCK_RE = re.compile(
    r"```(?:helper-clarify|helper-form)[^`]*```",
    re.DOTALL,
)


def _strip_ui_blocks(text: str) -> str:
    """移除消息中的 helper-clarify / helper-form JSON 代码块（UI 指令，对 LLM 无意义）。"""
    return _UI_BLOCK_RE.sub("", text).strip()


async def _resolve_display_names(session, msgs: list) -> dict[str, str]:
    """批量解析消息列表中所有发送者的显示名称，返回 {sender_id: name}。"""
    from sqlalchemy import select

    from app.db.models import BotAccount, User

    user_ids = {m.sender_id for m in msgs if m.sender_type == "user"}
    bot_ids = {m.sender_id for m in msgs if m.sender_type == "bot"}
    names: dict[str, str] = {}

    if user_ids:
        ur = await session.execute(select(User).where(User.user_id.in_(user_ids)))
        for u in ur.scalars().all():
            names[u.user_id] = u.display_name or u.username
    if bot_ids:
        br = await session.execute(select(BotAccount).where(BotAccount.bot_id.in_(bot_ids)))
        for b in br.scalars().all():
            names[b.bot_id] = b.display_name or b.username

    return names


# Alias for history_pager.py compatibility
_get_names_for_messages = _resolve_display_names


async def _fetch_user_display_name(session, user_id: str) -> str:
    """获取单个用户的显示名称，失败时返回空字符串。"""
    if not user_id:
        return ""
    from sqlalchemy import select

    from app.db.models import User

    r = await session.execute(select(User).where(User.user_id == user_id))
    u = r.scalar_one_or_none()
    return (u.display_name or u.username) if u else ""


async def _fetch_reply_context(session, replied_msg_id: str) -> str:
    """
    获取被回复消息的摘要前缀，格式：「回复 [发送者]: <内容摘要>」

    供内置助手理解当前消息所针对的上文，返回空字符串表示无回复上下文。
    """
    if not replied_msg_id:
        return ""
    from sqlalchemy import select

    from app.db.models import BotAccount, User
    from app.db.models import Message as MsgModel

    r = await session.execute(select(MsgModel).where(MsgModel.msg_id == replied_msg_id))
    msg = r.scalar_one_or_none()
    if not msg:
        return ""

    quoted = _strip_ui_blocks(msg.content or "")
    if not quoted:
        return ""
    if len(quoted) > 300:
        quoted = quoted[:300] + "…"

    # Resolve sender names.
    sender_label = ""
    if msg.sender_type == "user":
        ur = await session.execute(select(User).where(User.user_id == msg.sender_id))
        u = ur.scalar_one_or_none()
        sender_label = (u.display_name or u.username) if u else ""
    else:
        br = await session.execute(select(BotAccount).where(BotAccount.bot_id == msg.sender_id))
        b = br.scalar_one_or_none()
        sender_label = (b.display_name or b.username) if b else ""

    if sender_label:
        return f"「回复 [{sender_label}]：{quoted}」\n\n"
    return f"「回复：{quoted}」\n\n"


async def _fetch_recent_history(
    session,
    channel_id: str,
    before_msg_id: str | None,
    limit: int = HISTORY_MSG_COUNT,
) -> list:
    """
    从 DB 拉取当前触发消息之前的最近 limit 条非空消息，
    转换为带发送者标识的 LangChain HumanMessage / AIMessage 列表（时间正序）。

    每条消息格式：[发送者名称]: <内容>
    使用 before_msg_id 精确定位，避免把当前轮次的消息重复带入。
    """
    from sqlalchemy import select

    from app.db.models import Message as MsgModel

    q = select(MsgModel).where(
        MsgModel.channel_id == channel_id,
        MsgModel.content != "",
    )

    if before_msg_id:
        sub = select(MsgModel.created_at).where(MsgModel.msg_id == before_msg_id).scalar_subquery()
        q = q.where(MsgModel.created_at < sub)

    q = q.order_by(MsgModel.created_at.desc()).limit(limit)
    result = await session.execute(q)
    msgs = list(result.scalars().all())
    msgs.reverse()  # Convert to chronological order.

    display_names = await _resolve_display_names(session, msgs)

    lc_messages: list = []
    for m in msgs:
        content = _strip_ui_blocks(m.content or "")
        if not content:
            continue
        # Strip the > [Author]: snippet\n\n reply-quote prefix added by the
        # frontend's reply UI so the LLM doesn't learn to mimic this format.
        content = re.sub(r"^> \[[^\]]+\]: .+?\n\n", "", content, count=1, flags=re.DOTALL).strip()
        if not content:
            continue
        if len(content) > HISTORY_MSG_MAX_CHARS:
            content = content[:HISTORY_MSG_MAX_CHARS] + "…"
        name = display_names.get(m.sender_id, "")
        labeled = f"[{name}]: {content}" if name else content
        if m.sender_type == "user":
            lc_messages.append(HumanMessage(content=labeled))
        else:
            lc_messages.append(AIMessage(content=labeled))

    return lc_messages


# ─── Agent Loop ───────────────────────────────────────────────────────────────


async def _run_agent_iter(
    system_prompt: str,
    user_content: str | list,
    ctx: dict,
    history: list | None = None,
):
    """使用 LangChain bind_tools + 手动 agent loop 运行 Agent，async-iterator 流式输出。

    Yields ``Delta(text)`` per token chunk and tool-progress marker, then
    a terminal ``Final(content)`` when the agent settles. Replaces the
    legacy stream_cb callback path.
    """
    from app.features.bot_runtime.pipeline.adapter_events import Delta, Final

    cfg = _get_llm_config()
    if not cfg:
        yield Final(content="", success=True)
        return

    try:
        llm = _make_llm(cfg)
    except Exception as e:
        logger.exception("channel_bot: failed to create LLM: %s", e)
        yield Final(content="", success=True)
        return

    tools = _make_tools(ctx)
    tool_map = {t.name: t for t in tools}
    llm_with_tools = llm.bind_tools(tools)

    messages: list = [
        SystemMessage(content=system_prompt),
        *(history or []),
        HumanMessage(content=user_content),
    ]

    if logger.isEnabledFor(logging.DEBUG):
        logger.debug(
            "channel_bot[_run_agent]: system_prompt(%d chars):\n%s",
            len(system_prompt),
            system_prompt,
        )
        if isinstance(user_content, list):
            parts_summary = ", ".join(p.get("type", "?") for p in user_content if isinstance(p, dict))
            logger.debug(
                "channel_bot[_run_agent]: user_content=[%s] (%d parts)",
                parts_summary,
                len(user_content),
            )
        else:
            logger.debug(
                "channel_bot[_run_agent]: user_content(%d chars):\n%s",
                len(user_content),
                user_content,
            )
        if history:
            logger.debug(
                "channel_bot[_run_agent]: history=%d messages",
                len(history),
            )

    for iteration in range(MAX_LOOP_ITERATIONS):
        response: AIMessage | None = None
        accumulated = None
        streaming_success = False
        try:
            async for chunk in llm_with_tools.astream(messages):
                streaming_success = True
                accumulated = chunk if accumulated is None else accumulated + chunk
                # Forward pure text tokens — skip tool-call argument chunks
                if chunk.content and isinstance(chunk.content, str) and not getattr(chunk, "tool_call_chunks", None):
                    yield Delta(text=chunk.content)
        except Exception as e:
            logger.warning(
                "channel_bot: LLM stream error iteration=%d: %s, falling back to non-streaming",
                iteration,
                e,
            )
            try:
                response = await llm_with_tools.ainvoke(messages)
            except Exception as e2:
                logger.exception("channel_bot: LLM invoke fallback also failed: %s", e2)
                break
        else:
            if streaming_success and accumulated is not None:
                response = cast(AIMessage, accumulated)
            else:
                # No chunks received, try non-streaming
                try:
                    response = await llm_with_tools.ainvoke(messages)
                except Exception as e:
                    logger.exception("channel_bot: LLM invoke fallback failed: %s", e)
                    break

        if response is None:
            logger.warning("channel_bot: LLM returned None at iteration=%d", iteration)
            break

        tool_calls = getattr(response, "tool_calls", None) or []

        if not tool_calls:
            # No tool calls → final answer
            content = response.content
            if isinstance(content, list):
                content = " ".join(part.get("text", "") for part in content if isinstance(part, dict))
            yield Final(content=str(content or "").strip(), success=True)
            return

        # Append assistant turn to history
        messages.append(response)

        logger.info(
            "channel_bot: agent loop iter=%d tools=%s channel=%s",
            iteration,
            [tc.get("name") for tc in tool_calls],
            ctx.get("channel_id", ""),
        )

        # Execute each tool call
        for tc in tool_calls:
            tool_name = tc.get("name", "")
            tool_args = tc.get("args") or {}
            tool_call_id = tc.get("id") or tool_name

            label = _tool_label(tool_name, tool_args if isinstance(tool_args, dict) else {})
            yield Delta(text=f"\n\n`🔧 {label}…`")

            t = tool_map.get(tool_name)
            if t is None:
                result_str = f"错误：未知工具 {tool_name}"
            else:
                try:
                    result_str = str(await t.ainvoke(tool_args))
                except Exception as e:
                    logger.exception("channel_bot[tool]: %s failed: %s", tool_name, e)
                    result_str = f"工具执行出错：{e}"

            if tool_name != "call_user":
                yield Delta(text=" ✓\n\n")

            messages.append(ToolMessage(content=result_str, tool_call_id=tool_call_id))

            # return_direct: stop immediately and return this tool's output
            if t is not None and getattr(t, "return_direct", False):
                yield Final(content=result_str, success=True)
                return

    # Max iterations reached — return last assistant content
    logger.warning(
        "channel_bot: agent loop reached max iterations (%d) channel=%s",
        MAX_LOOP_ITERATIONS,
        ctx.get("channel_id", ""),
    )
    last_ai = next((m for m in reversed(messages) if isinstance(m, AIMessage)), None)
    if last_ai:
        content = last_ai.content
        if isinstance(content, list):
            content = " ".join(part.get("text", "") for part in content if isinstance(part, dict))
        yield Final(content=str(content or "").strip(), success=True)
        return
    yield Final(content="", success=True)


# ─── Adapter ──────────────────────────────────────────────────────────────────


class ChannelBotAdapter(BotAdapter):
    """@channel bot 内置适配器：LangChain Agent 驱动，支持 call_bot / call_user / update_anchor / update_decision 等工具。"""

    async def execute(self, payload: AgentPayload):
        from app.features.bot_runtime.pipeline.adapter_events import Delta, Final

        user_text = payload.message.text
        all_attachments = payload.context.attachments or []

        # Split image and document attachments.
        image_attachments = [a for a in all_attachments if a.get("is_image") == "true"]
        doc_attachments = [a for a in all_attachments if a.get("is_image") != "true"]

        # Document attachments only inject file references; agents call read_file on demand for body text.
        file_refs = _build_file_refs_note(doc_attachments)
        if file_refs:
            user_text = (user_text.strip() + "\n\n" + file_refs) if user_text.strip() else file_refs

        memory = payload.context.memory or {}
        channel_id = payload.channel_id
        pconfig = payload.runtime
        channel_bots: list[str] = pconfig.channel_bot_usernames
        bot_details: dict = pconfig.channel_bot_details
        sender_id = payload.message.sender_id

        # 1. Build the system prompt.
        members_lines: list[str] = []
        for uname in channel_bots:
            detail = bot_details.get(uname) or {}
            display = detail.get("display_name") or uname
            desc = detail.get("description") or ""
            caps: list[str] = []
            try:
                intro = json.loads(detail.get("intro") or "{}")
                caps = intro.get("capabilities") or []
            except Exception:
                pass
            line = f"- @{uname}（{display}）"
            if desc:
                line += f"：{desc}"
            if caps:
                line += f"  能力：{'、'.join(caps)}"
            members_lines.append(line)
        members_section = "\n".join(members_lines) if members_lines else "（暂无其他专业 Bot）"

        system_prompt = "\n\n".join(
            [
                "你是 AgentNexus 内置智能协作助手，兼顾使用引导、项目助手、协作协调三个职责。",
                "=== 系统帮助文档（回答使用类问题时参考）===\n" + get_help_context_for_llm(),
                render_channel_memory_xml(memory) or '<channel_memory version="1" />',
                (
                    f"=== 当前澄清上下文 ===\n【原始问题】\n{payload.context.original_question_text}\n"
                    if payload.context.original_question_text
                    else ""
                ),
                "=== 频道 Bot 成员（可通过 call_bot 工具调用）===\n" + members_section,
                (
                    "## 核心行为准则\n\n"
                    "- 用户消息信息不足、意图模糊或需要关键决策时，**第一步必须调用 call_user** 向相关用户收集信息，不要猜测或直接执行\n"
                    "- call_user 的 username 从对话历史中获取（历史消息格式为 [用户名]: 消息内容）；需要提问时填写 options\n"
                    "- 先调用所有必要工具，结果返回后再输出最终回复\n"
                    "- 最终回复使用简洁专业的 Markdown 格式\n\n"
                    "## 记忆维护职责（必须严格执行）\n\n"
                    "在每次对话中，你必须主动判断是否需要更新以下记忆层，**不要等用户主动要求**：\n\n"
                    "- **update_anchor**：若用户提到项目目标、范围、核心约束、背景发生变化，或锚点为空，立即更新。"
                    "锚点是最高优先级记忆，必须始终保持最新、准确。\n"
                    "- **update_progress**：若用户汇报进展、完成了某项任务、提到阶段成果、当前卡点或下一步计划，立即更新进度。"
                    "进度文件应包含：已完成事项、当前状态、下一步计划。\n"
                    "- **update_decision**：若对话中产生了重要决策、技术选型、方案确认，立即记录。\n\n"
                    "**触发原则**：宁可多更新，不要遗漏。每轮对话结束前，先检查是否有需要持久化的信息，再输出最终回复。"
                ),
            ]
        )

        # 2. Store clarification answers into decisions automatically.
        if user_text.startswith(_CLARIFY_PREFIX):
            answer_body = user_text[len(_CLARIFY_PREFIX) :].strip()
            if answer_body:
                from datetime import datetime, timezone

                from app.features.memory.manager import save_layer

                ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
                entry = f"### 用户澄清选择（{ts}）\n{answer_body}"
                existing = (memory.get("decisions") or "").rstrip()
                new_decisions = f"{existing}\n\n{entry}".strip() if existing else entry
                await save_layer(channel_id, "decisions", new_decisions)
                memory = dict(memory)
                memory["decisions"] = new_decisions
                logger.info("channel_bot: clarify answer saved to decisions channel=%s", channel_id)

        # 3. Tool context.
        # Tools mostly read run_ctx (see call_bot) or task-specific fields;
        # the loose closures (_pre_create_bot_msg, _adapter_factory, etc.)
        # that used to live here moved into BotMessageWriter / dispatch_one.
        tool_ctx: dict = {
            "channel_id": channel_id,
            "memory": memory,
            "task_id": payload.task_id,
            "sender_id": sender_id,
            "sender_name": pconfig.sender_name or payload.message.sender_name,
            "channel_name": pconfig.channel_name,
            "attachments": payload.context.attachments or [],
            "original_question_text": payload.context.original_question_text,
            "_db_session": pconfig.db_session,
            "_bot_id": pconfig.bot_id,
            "_event_bus": pconfig.event_bus,
            "_run_ctx": pconfig.run_ctx,
        }

        # 4. Load history, user info, and reply context.
        chat_history: list = []
        db_session = pconfig.db_session
        trigger_meta = payload.trigger_message or {}
        trigger_msg_id = trigger_meta.get("msg_id")
        in_reply_to_msg_id = trigger_meta.get("in_reply_to_msg_id")
        current_user_name = ""
        reply_prefix = ""

        if db_session:
            try:
                import asyncio as _asyncio

                async def _noop_list() -> list:
                    return []

                async def _noop_str() -> str:
                    return ""

                _results = await _asyncio.gather(
                    _fetch_recent_history(db_session, channel_id, trigger_msg_id) if trigger_msg_id else _noop_list(),
                    _fetch_user_display_name(db_session, sender_id),
                    _fetch_reply_context(db_session, in_reply_to_msg_id) if in_reply_to_msg_id else _noop_str(),
                    return_exceptions=True,
                )
                chat_history = _results[0] if not isinstance(_results[0], BaseException) else []
                current_user_name = _results[1] if not isinstance(_results[1], BaseException) else ""
                reply_prefix = _results[2] if not isinstance(_results[2], BaseException) else ""

                logger.debug(
                    "channel_bot: history=%d user=%r reply=%s channel=%s",
                    len(chat_history),
                    current_user_name,
                    bool(reply_prefix),
                    channel_id,
                )
            except Exception:
                logger.warning(
                    "channel_bot: context fetch failed channel=%s, proceeding without",
                    channel_id,
                )

        # Clarification answers strip the "@channel bot clarification answer:" prefix and skip reply_prefix.
        # The original question is already in the system prompt clarification context.
        _is_clarify = user_text.startswith(_CLARIFY_PREFIX)
        if _is_clarify:
            user_text = user_text[len(_CLARIFY_PREFIX) :].strip()
            reply_prefix = ""  # helper-clarify messages are not useful to the LLM.

        # Inject reply context and sender identity into the current user message.
        if reply_prefix:
            user_text = reply_prefix + user_text
        if current_user_name:
            user_text = f"[{current_user_name}]: {user_text}"

        # 5. Agent execution with multimodal Vision support.
        cfg = _get_llm_config()
        supports_vision = (cfg or {}).get("supports_vision", True) if cfg else True

        # When images are attached, inject file_id into text so the LLM can reference attachment context.
        if image_attachments:
            img_ids_note = "\n\n[系统提示] 用户本次上传了以下图片附件：\n" + "\n".join(
                f"- file_id: {a['file_id']}  文件名: {a.get('filename') or a.get('file_id')}"
                for a in image_attachments
                if a.get("file_id")
            )
            user_text = user_text + img_ids_note

        if supports_vision and any(a.get("image_b64") for a in image_attachments):
            user_content: str | list = _build_vision_content(user_text, image_attachments)
        else:
            if image_attachments:
                user_text += "\n\n（注：当前 LLM 未启用图片识别，已忽略图片附件。）"
            user_content = user_text

        # Stream Delta tokens directly out; capture the agent's final content.
        agent_final: Final | None = None
        async for event in _run_agent_iter(
            system_prompt,
            user_content,
            tool_ctx,
            history=chat_history,
        ):
            if isinstance(event, Delta):
                yield event
            elif isinstance(event, Final):
                agent_final = event
                break

        content = agent_final.content if agent_final else ""

        # 5. Keyword fallback when the LLM is unavailable.
        if not content:
            content = (
                _build_attachment_fallback_reply(user_text, payload.context.attachments)
                or build_help_content_with_form(user_text)
                or _DEFAULT_REPLY
            )
            logger.info(
                "channel_bot: LLM unavailable, keyword fallback channel=%s msg=%s",
                channel_id,
                (user_text[:60] + "…") if len(user_text) > 60 else user_text,
            )

        created_file_ids = tool_ctx.get("_created_file_ids") or []
        yield Final(content=content, success=True, file_ids=created_file_ids)

    async def health_check(self) -> bool:
        return _get_llm_config() is not None

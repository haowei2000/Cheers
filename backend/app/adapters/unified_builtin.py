"""统一内置 Bot 适配器：LangChain Agent + 工具集。

工具：
  call_bot        — @某Bot，将子任务委托给频道内专业 Bot
  update_anchor   — 更新四层记忆中的锚点层
  update_decision — 更新四层记忆中的决策层
  update_progress — 更新四层记忆中的进度层
  ask_user        — 向用户发出选择题，Agent 暂停等待回答
  create_file     — 将内容保存为 MD 文件，返回下载链接

Agent：使用 LangChain bind_tools + 手动 agent loop，
       通过 OpenAI function calling API 实现结构化工具调用。
"""
import json
import logging
import re
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

from app.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.admin.settings_store import get_provider_for_scope
from app.guide.help_index import (
    build_guide_content_with_form,
    get_form_for_intent,
    get_help_context_for_llm,
)

logger = logging.getLogger("app.adapters.unified_builtin")

MAX_LOOP_ITERATIONS = 8
HISTORY_MSG_COUNT = 20       # 注入 LLM 的历史消息条数上限
HISTORY_MSG_MAX_CHARS = 600  # 单条历史消息截断长度

_DEFAULT_REPLY = (
    "您可以说：怎么创建项目、怎么加入项目、怎么接入 OpenClaw、怎么发消息、"
    "左边没有项目、@ 没反应、怎么安装、报错排查 等，我会根据说明书为您引导。"
    "也可以直接问项目相关问题，我会结合频道上下文回答。"
)


# ─── LLM 配置 ─────────────────────────────────────────────────────────────────

def _get_llm_config() -> dict | None:
    """优先 channel_bot，依次回退 orchestrator / system_llm。"""
    for scope in ("channel_bot", "orchestrator", "system_llm"):
        cfg = get_provider_for_scope(scope)
        if cfg and cfg.get("base_url") and cfg.get("model"):
            return cfg
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


# ─── 工具标签 ──────────────────────────────────────────────────────────────────

def _tool_label(tool_name: str, args: dict) -> str:
    """Human-readable label for a tool call notification."""
    if tool_name == "call_bot":
        return f"调用 @{args.get('username', '?')}"
    if tool_name == "update_anchor":
        return "更新项目锚点"
    if tool_name == "update_decision":
        return "记录决策"
    if tool_name == "update_progress":
        return "更新项目进度"
    if tool_name == "ask_user":
        return "向用户提问"
    if tool_name == "create_file":
        return f"创建文件 {args.get('filename', '?')}.md"
    if tool_name == "generate_image":
        return f"生成图片：{args.get('prompt', '?')[:30]}"
    if tool_name == "edit_image":
        return f"编辑图片：{args.get('prompt', '?')[:30]}"
    return tool_name


# ─── 工具工厂 ──────────────────────────────────────────────────────────────────

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
        from app.memory.manager import save_layer
        await save_layer(ctx["channel_id"], "anchor", content.strip())
        logger.info(
            "unified_builtin[tool]: update_anchor channel=%s len=%d",
            ctx["channel_id"], len(content),
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
        from app.memory.manager import save_layer
        await save_layer(ctx["channel_id"], "progress", content.strip())
        logger.info(
            "unified_builtin[tool]: update_progress channel=%s len=%d",
            ctx["channel_id"], len(content),
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
        from app.memory.manager import save_layer
        await save_layer(ctx["channel_id"], "decisions", content.strip())
        logger.info(
            "unified_builtin[tool]: update_decision channel=%s len=%d",
            ctx["channel_id"], len(content),
        )
        return "已更新决策记录"

    @tool
    async def call_bot(username: str, message: str) -> str:
        """调用频道内指定专业 Bot 处理子任务，结果会广播到频道并反馈到对话中。

        Args:
            username: Bot 用户名（不含 @ 符号）
            message: 发给该 Bot 的任务描述
        """
        username = username.strip().lstrip("@")
        message = message.strip()
        if not username or not message:
            return "错误：需要提供 username 和 message"

        bot_id_by_username: dict = ctx.get("bot_id_by_username") or {}
        adapter_factory = ctx.get("adapter_factory")
        create_and_broadcast = ctx.get("create_and_broadcast")
        pre_create_bot_msg = ctx.get("_pre_create_bot_msg")
        finalize_bot_msg = ctx.get("_finalize_bot_msg")
        make_stream_token_cb = ctx.get("_make_stream_token_cb")

        if username not in bot_id_by_username:
            available = list(bot_id_by_username.keys())
            return f"错误：频道内没有 @{username}，可用 Bot：{available}"
        if not adapter_factory:
            return "错误：adapter_factory 未注入（内部错误）"

        bot_id = bot_id_by_username[username]
        try:
            adapter = await adapter_factory(bot_id)
            task_id = ctx.get("task_id", "")

            if pre_create_bot_msg and finalize_bot_msg and make_stream_token_cb:
                # 流式路径：预先创建空消息气泡，边生成边推送 delta，完成后写入最终内容
                bot_msg = await pre_create_bot_msg(bot_id, task_id)
                sub_payload = AgentPayload(
                    task_id=task_id,
                    channel_id=ctx["channel_id"],
                    trigger_message={
                        "user": ctx.get("sender_id", ""),
                        "text": message,
                        "timestamp": "",
                    },
                    memory_context=ctx.get("memory") or {},
                    attachments=ctx.get("attachments") or [],
                    original_question_text=ctx.get("original_question_text"),
                    process_config={"_stream_token": make_stream_token_cb(bot_msg.msg_id)},
                )
                resp: AgentResponse = await adapter.execute(sub_payload)
                result = resp.content if resp.success else (resp.error_message or "Bot 执行出错")
                await finalize_bot_msg(bot_msg, result)
            else:
                # 降级路径：非流式，执行完成后一次性广播
                sub_payload = AgentPayload(
                    task_id=task_id,
                    channel_id=ctx["channel_id"],
                    trigger_message={
                        "user": ctx.get("sender_id", ""),
                        "text": message,
                        "timestamp": "",
                    },
                    memory_context=ctx.get("memory") or {},
                    attachments=ctx.get("attachments") or [],
                    original_question_text=ctx.get("original_question_text"),
                )
                resp = await adapter.execute(sub_payload)
                result = resp.content if resp.success else (resp.error_message or "Bot 执行出错")
                if create_and_broadcast:
                    await create_and_broadcast(bot_id, result)

            logger.info(
                "unified_builtin[tool]: call_bot @%s completed channel=%s",
                username, ctx["channel_id"],
            )
            return f"@{username} 回复：\n{result}"
        except Exception as e:
            logger.exception("unified_builtin[tool]: call_bot @%s failed: %s", username, e)
            return f"@{username} 调用出错：{e}"

    @tool(return_direct=True)
    async def ask_user(
        question: str,
        options: list[str],
        allow_multiple: bool = False,
        allow_manual: bool = False,
        manual_label: str = "其他（手动输入）",
        manual_placeholder: str = "请输入您的回答...",
    ) -> str:
        """向用户发出选择题，Agent 立即暂停等待用户回答后再继续。

        Args:
            question: 问题标题
            options: 选项列表（至少 2 个）
            allow_multiple: 是否允许多选，默认 False
            allow_manual: 是否允许手动输入，默认 False。设为 True 时会在选项末尾添加手动输入框
            manual_label: 手动输入选项的显示标签，默认 "其他（手动输入）"
            manual_placeholder: 手动输入框的占位提示文字，默认 "请输入您的回答..."
        """
        if not question.strip() or len(options) < 2:
            return "错误：ask_user 需要 question 和至少 2 个选项"

        clarify_schema = {
            "title": question,
            "skip_policy": "allow",
            "questions": [
                {
                    "id": "q0",
                    "prompt": question,
                    "allow_multiple": allow_multiple,
                    "options": [{"id": f"a{i}", "label": str(opt)} for i, opt in enumerate(options)],
                    "other_enabled": allow_manual,
                    "other_label": manual_label or "其他（手动输入）",
                    "other_placeholder": manual_placeholder or "请输入您的回答...",
                }
            ],
        }
        return "```guide-clarify\n" + json.dumps(clarify_schema, ensure_ascii=False) + "\n```"

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

        download_url = f"/api/files/{file_id}/download"
        logger.info(
            "unified_builtin[tool]: create_file %s channel=%s",
            original_filename, channel_id,
        )
        return f"文件已创建：[{original_filename}]({download_url})\n\n下载链接：`{download_url}`"

    @tool
    async def generate_image(prompt: str, size: str = "1024*1024") -> str:
        """根据文字描述生成图片，并将图片发送到频道。

        Args:
            prompt: 图片描述，越详细效果越好
            size: 图片尺寸，支持 1024*1024 / 720*1280 / 1280*720 / 768*1024 / 1024*768，默认 1024*1024
        """
        import uuid
        from datetime import datetime

        from app.chat_core.ws_manager import ws_manager
        from app.db.models import FileRecord, Message
        from app.image_gen.service import ImageGenError, ImageGenService

        channel_id = ctx["channel_id"]
        sender_id = ctx.get("sender_id") or "system"
        db_session = ctx.get("_db_session")

        if not db_session:
            return "错误：数据库会话未注入（内部错误）"

        try:
            from app.storage.bootstrap import get_storage_service
            storage = get_storage_service()
        except Exception:
            storage = None

        svc = ImageGenService(storage=storage)
        last_err = ""
        for attempt in range(1, 4):
            try:
                result = await svc.generate(
                    session=db_session,
                    channel_id=channel_id,
                    sender_id=sender_id,
                    prompt=prompt,
                    size=size,
                )
                await db_session.commit()
                break
            except ImageGenError as exc:
                last_err = exc.detail
                logger.warning("generate_image attempt %d failed: %s", attempt, exc.detail)
                if attempt == 3:
                    return f"图片生成失败（已重试 3 次）：{last_err}"
            except Exception as exc:
                last_err = str(exc)
                logger.exception("unified_builtin[tool]: generate_image attempt %d unexpected error", attempt)
                if attempt == 3:
                    return f"图片生成失败（已重试 3 次）：{last_err}"
        else:
            return f"图片生成失败：{last_err}"

        # 创建带 file_ids 的消息并广播
        bot_id = ctx.get("task_id", sender_id)  # 用 bot_id 发送图片消息
        # 用 sender_id 对应的 bot（即当前 bot）发图片消息
        # sender_id here is the user, we need bot_id — use _bot_id from ctx if available
        actual_bot_id = ctx.get("_bot_id") or sender_id
        img_msg = Message(
            channel_id=channel_id,
            sender_id=actual_bot_id,
            sender_type="bot",
            content="",
            file_ids=[result.file_id],
            task_id=ctx.get("task_id"),
        )
        db_session.add(img_msg)
        await db_session.flush()
        from app.chat_core.schemas import MessageInResponse
        data = MessageInResponse.model_validate(img_msg).model_dump()
        if img_msg.created_at:
            data["created_at"] = img_msg.created_at.isoformat()
        data["files"] = [{"file_id": result.file_id, "preview_url": result.preview_url, "content_type": result.content_type}]
        await ws_manager.broadcast_to_channel(channel_id, {"type": "message", "data": data})
        stream_event = ctx.get("_stream_event")
        if stream_event:
            await stream_event("message", data)
        await db_session.commit()

        logger.info("unified_builtin[tool]: generate_image ok file_id=%s", result.file_id)
        return f"图片已生成并发送到频道（file_id: {result.file_id}）"

    @tool
    async def edit_image(prompt: str, source_file_id: str = "", size: str = "1024*1024") -> str:
        """对已上传的图片进行 AI 编辑/风格转换（添加元素、替换背景、改变风格等），并将结果发送到频道。
        用户上传了图片并要求修改、添加元素、换背景、调整风格时，必须使用此工具而非 generate_image。

        Args:
            prompt: 编辑描述，例如"将背景换成火山景观""给图中的鸟添加一只羚羊"
            source_file_id: 源图片的 file_id；留空则自动使用用户最近上传的图片
            size: 输出尺寸，支持 1024*1024 / 720*1280 / 1280*720 / 768*1024 / 1024*768
        """
        from app.chat_core.ws_manager import ws_manager
        from app.db.models import Message
        from app.image_gen.service import ImageGenError, ImageGenService

        channel_id = ctx["channel_id"]
        sender_id = ctx.get("sender_id") or "system"
        db_session = ctx.get("_db_session")

        if not db_session:
            return "错误：数据库会话未注入（内部错误）"

        # 自动推断 source_file_id：优先用参数，否则用第一个图片附件
        fid = (source_file_id or "").strip()
        if not fid:
            for att in (ctx.get("attachments") or []):
                if att.get("is_image") == "true" and att.get("file_id"):
                    fid = att["file_id"]
                    logger.info("edit_image: auto-detected source_file_id=%s", fid)
                    break
        if not fid:
            return "错误：未找到源图片，请先上传要编辑的图片"

        try:
            from app.storage.bootstrap import get_storage_service
            storage = get_storage_service()
        except Exception:
            storage = None

        svc = ImageGenService(storage=storage)
        last_err = ""
        for attempt in range(1, 4):
            try:
                result = await svc.edit(
                    session=db_session,
                    channel_id=channel_id,
                    sender_id=sender_id,
                    source_file_id=fid,
                    prompt=prompt,
                    size=size,
                )
                await db_session.commit()
                break
            except ImageGenError as exc:
                last_err = exc.detail
                logger.warning("edit_image attempt %d failed: %s", attempt, exc.detail)
                if attempt == 3:
                    return f"图片编辑失败（已重试 3 次）：{last_err}"
            except Exception as exc:
                last_err = str(exc)
                logger.exception("unified_builtin[tool]: edit_image attempt %d unexpected error", attempt)
                if attempt == 3:
                    return f"图片编辑失败（已重试 3 次）：{last_err}"
        else:
            return f"图片编辑失败：{last_err}"

        actual_bot_id = ctx.get("_bot_id") or sender_id
        img_msg = Message(
            channel_id=channel_id,
            sender_id=actual_bot_id,
            sender_type="bot",
            content="",
            file_ids=[result.file_id],
            task_id=ctx.get("task_id"),
        )
        db_session.add(img_msg)
        await db_session.flush()
        from app.chat_core.schemas import MessageInResponse
        data = MessageInResponse.model_validate(img_msg).model_dump()
        if img_msg.created_at:
            data["created_at"] = img_msg.created_at.isoformat()
        data["files"] = [{"file_id": result.file_id, "preview_url": result.preview_url, "content_type": result.content_type}]
        await ws_manager.broadcast_to_channel(channel_id, {"type": "message", "data": data})
        stream_event = ctx.get("_stream_event")
        if stream_event:
            await stream_event("message", data)
        await db_session.commit()

        logger.info("unified_builtin[tool]: edit_image ok file_id=%s", result.file_id)
        return f"图片已编辑并发送到频道（file_id: {result.file_id}）"

    return [update_anchor, update_progress, update_decision, call_bot, ask_user, create_file, generate_image, edit_image]


# ─── 附件处理 ──────────────────────────────────────────────────────────────────

def _merge_attachments_into_text(user_text: str, attachments: list[dict[str, str]] | None) -> str:
    """将文件解析结果拼接进内置 Bot 的用户消息。"""
    if not attachments:
        return user_text
    parts = [user_text.strip(), "", "以下是用户上传文件的解析结果，请结合这些内容处理："]
    for index, attachment in enumerate(attachments, start=1):
        parts.append(f"## 文件 {index}")
        parts.append(f"文件名: {attachment.get('filename') or attachment.get('file_id') or 'unknown'}")
        if attachment.get("content_type"):
            parts.append(f"类型: {attachment['content_type']}")
        if attachment.get("summary"):
            parts.append("摘要:")
            parts.append(attachment["summary"])
        parts.append("正文:")
        parts.append(attachment.get("content") or "")
        if attachment.get("truncated") == "true":
            parts.append("注意: 该文件文本已按长度限制截断。")
        parts.append("")
    return "\n".join(parts).strip()


def _build_vision_content(user_text: str, attachments: list[dict[str, str]] | None) -> list[dict]:
    """将文本和图片附件构建为 OpenAI Vision 格式的多模态 content 数组。"""
    parts: list[dict] = [{"type": "text", "text": user_text}]
    for att in (attachments or []):
        if att.get("is_image") != "true":
            continue
        b64 = att.get("image_b64", "")
        if not b64:
            continue
        mime = att.get("content_type") or "image/jpeg"
        parts.append({
            "type": "image_url",
            "image_url": {"url": f"data:{mime};base64,{b64}"},
        })
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


# ─── 历史消息加载 ─────────────────────────────────────────────────────────────

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
    from app.db.models import BotAccount, Message as MsgModel, User

    r = await session.execute(select(MsgModel).where(MsgModel.msg_id == replied_msg_id))
    msg = r.scalar_one_or_none()
    if not msg:
        return ""

    quoted = (msg.content or "").strip()
    if not quoted:
        return ""
    if len(quoted) > 300:
        quoted = quoted[:300] + "…"

    # 解析发送者名称
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
        sub = (
            select(MsgModel.created_at)
            .where(MsgModel.msg_id == before_msg_id)
            .scalar_subquery()
        )
        q = q.where(MsgModel.created_at < sub)

    q = q.order_by(MsgModel.created_at.desc()).limit(limit)
    result = await session.execute(q)
    msgs = list(result.scalars().all())
    msgs.reverse()  # 转为时间正序

    display_names = await _resolve_display_names(session, msgs)

    lc_messages: list = []
    for m in msgs:
        content = (m.content or "").strip()
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

async def _run_agent(
    system_prompt: str,
    user_content: str | list,
    ctx: dict,
    stream_cb=None,
    history: list | None = None,
) -> str:
    """使用 LangChain bind_tools + 手动 agent loop 运行 Agent，支持流式输出。"""
    cfg = _get_llm_config()
    if not cfg:
        return ""

    try:
        llm = _make_llm(cfg)
    except Exception as e:
        logger.exception("unified_builtin: failed to create LLM: %s", e)
        return ""

    tools = _make_tools(ctx)
    tool_map = {t.name: t for t in tools}
    llm_with_tools = llm.bind_tools(tools)

    messages: list = [
        SystemMessage(content=system_prompt),
        *(history or []),
        HumanMessage(content=user_content),
    ]

    for iteration in range(MAX_LOOP_ITERATIONS):
        response: AIMessage | None = None

        if stream_cb:
            # Stream tokens, accumulate full response for tool call detection
            accumulated = None
            try:
                async for chunk in llm_with_tools.astream(messages):
                    # Accumulate chunks to reconstruct complete AIMessage
                    accumulated = chunk if accumulated is None else accumulated + chunk
                    # Forward pure text tokens — skip tool-call argument chunks
                    if (
                        chunk.content
                        and isinstance(chunk.content, str)
                        and not getattr(chunk, "tool_call_chunks", None)
                    ):
                        await stream_cb(chunk.content)
            except Exception as e:
                logger.exception("unified_builtin: LLM stream error iteration=%d: %s", iteration, e)
                break
            response = accumulated
        else:
            try:
                response = await llm_with_tools.ainvoke(messages)
            except Exception as e:
                logger.exception("unified_builtin: LLM invoke error iteration=%d: %s", iteration, e)
                break

        if response is None:
            logger.warning("unified_builtin: LLM returned None at iteration=%d", iteration)
            break

        tool_calls = getattr(response, "tool_calls", None) or []

        if not tool_calls:
            # No tool calls → final answer
            content = response.content
            if isinstance(content, list):
                # Multimodal content — extract text parts
                content = " ".join(
                    part.get("text", "") for part in content if isinstance(part, dict)
                )
            return str(content or "").strip()

        # Append assistant turn to history
        messages.append(response)

        logger.info(
            "unified_builtin: agent loop iter=%d tools=%s channel=%s",
            iteration,
            [tc.get("name") for tc in tool_calls],
            ctx.get("channel_id", ""),
        )

        # Execute each tool call
        for tc in tool_calls:
            tool_name = tc.get("name", "")
            tool_args = tc.get("args") or {}
            tool_call_id = tc.get("id") or tool_name

            if stream_cb:
                label = _tool_label(tool_name, tool_args if isinstance(tool_args, dict) else {})
                await stream_cb(f"\n\n`🔧 {label}…`")

            t = tool_map.get(tool_name)
            if t is None:
                result_str = f"错误：未知工具 {tool_name}"
            else:
                try:
                    result_str = str(await t.ainvoke(tool_args))
                except Exception as e:
                    logger.exception("unified_builtin[tool]: %s failed: %s", tool_name, e)
                    result_str = f"工具执行出错：{e}"

            if stream_cb and tool_name != "ask_user":
                await stream_cb(" ✓\n\n")

            messages.append(ToolMessage(content=result_str, tool_call_id=tool_call_id))

            # return_direct: stop immediately and return this tool's output
            if t is not None and getattr(t, "return_direct", False):
                return result_str

    # Max iterations reached — return last assistant content
    logger.warning(
        "unified_builtin: agent loop reached max iterations (%d) channel=%s",
        MAX_LOOP_ITERATIONS,
        ctx.get("channel_id", ""),
    )
    last_ai = next(
        (m for m in reversed(messages) if isinstance(m, AIMessage)), None
    )
    if last_ai:
        content = last_ai.content
        if isinstance(content, list):
            content = " ".join(
                part.get("text", "") for part in content if isinstance(part, dict)
            )
        return str(content or "").strip()
    return ""


# ─── Adapter ──────────────────────────────────────────────────────────────────

class UnifiedBuiltinBotAdapter(OpenClawAdapter):
    """统一内置 Bot：LangChain Agent 驱动，支持 call_bot / update_anchor / update_decision / ask_user。"""

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        user_text = (payload.trigger_message or {}).get("text") or ""
        all_attachments = payload.attachments or []

        # 分离图片与文档附件
        image_attachments = [a for a in all_attachments if a.get("is_image") == "true"]
        doc_attachments = [a for a in all_attachments if a.get("is_image") != "true"]

        # 文档附件合并为文本
        user_text = _merge_attachments_into_text(user_text, doc_attachments)

        memory = payload.memory_context or {}
        channel_id = payload.channel_id
        pconfig = payload.process_config or {}
        channel_bots: list[str] = pconfig.get("channel_bot_usernames") or []
        bot_details: dict = pconfig.get("channel_bot_details") or {}
        bot_id_by_username: dict = pconfig.get("bot_id_by_username") or {}
        adapter_factory = pconfig.get("_adapter_factory")
        create_and_broadcast = pconfig.get("_create_and_broadcast")
        sender_id = (payload.trigger_message or {}).get("user") or ""

        # ── 1. 构建 System Prompt ──────────────────────────────────────────────
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

        system_prompt = "\n\n".join([
            "你是 AgentNexus 内置智能协作助手，兼顾使用引导、项目助手、协作协调三个职责。",
            "=== 系统帮助文档（回答使用类问题时参考）===\n" + get_help_context_for_llm(),
            (
                "=== 项目记忆 ===\n"
                f"【锚点·最高优先级】\n{memory.get('anchor') or '（暂无）'}\n\n"
                f"【项目进度】\n{memory.get('progress') or '（暂无）'}\n\n"
                f"【决策记录】\n{memory.get('decisions') or '（暂无）'}\n\n"
                f"【资料索引】\n{memory.get('files_index') or '（暂无）'}\n\n"
                f"【最近关注】\n{memory.get('recent') or '（暂无）'}"
            ),
            (
                f"=== 当前澄清上下文 ===\n【原始问题】\n{payload.original_question_text}\n"
                if payload.original_question_text else ""
            ),
            "=== 频道 Bot 成员（可通过 call_bot 工具调用）===\n" + members_section,
            (
                "## 核心行为准则\n\n"
                "- 用户消息信息不足、意图模糊或需要关键决策时，**第一步必须调用 ask_user** 收集信息，不要猜测或直接执行\n"
                "- 先调用所有必要工具，结果返回后再输出最终回复\n"
                "- 最终回复使用简洁专业的 Markdown 格式\n\n"
                "## 图片工具使用准则（严格遵守）\n\n"
                "- **用户上传了图片** 且要求「添加/替换/修改/编辑/改变/调整/换背景/添加元素」→ **必须调用 edit_image**，"
                "source_file_id 留空即可（工具会自动使用上传的图片）\n"
                "- **没有上传图片**，用户要求「生成/画/创作一张」新图片 → 调用 generate_image\n"
                "- **绝对禁止**：用户上传了图片却调用 generate_image；这会创建全新图片而非编辑原图\n\n"
                "## 记忆维护职责（必须严格执行）\n\n"
                "在每次对话中，你必须主动判断是否需要更新以下记忆层，**不要等用户主动要求**：\n\n"
                "- **update_anchor**：若用户提到项目目标、范围、核心约束、背景发生变化，或锚点为空，立即更新。"
                "锚点是最高优先级记忆，必须始终保持最新、准确。\n"
                "- **update_progress**：若用户汇报进展、完成了某项任务、提到阶段成果、当前卡点或下一步计划，立即更新进度。"
                "进度文件应包含：已完成事项、当前状态、下一步计划。\n"
                "- **update_decision**：若对话中产生了重要决策、技术选型、方案确认，立即记录。\n\n"
                "**触发原则**：宁可多更新，不要遗漏。每轮对话结束前，先检查是否有需要持久化的信息，再输出最终回复。"
            ),
        ])

        # ── 2. 澄清回答自动存入 decisions ─────────────────────────────────────
        _CLARIFY_PREFIX = "@channel bot 澄清回答："
        if user_text.startswith(_CLARIFY_PREFIX):
            answer_body = user_text[len(_CLARIFY_PREFIX):].strip()
            if answer_body:
                from app.memory.manager import save_layer
                from datetime import datetime, timezone
                ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
                entry = f"### 用户澄清选择（{ts}）\n{answer_body}"
                existing = (memory.get("decisions") or "").rstrip()
                new_decisions = f"{existing}\n\n{entry}".strip() if existing else entry
                await save_layer(channel_id, "decisions", new_decisions)
                memory = dict(memory)
                memory["decisions"] = new_decisions
                logger.info("unified_builtin: clarify answer saved to decisions channel=%s", channel_id)

        # ── 3. 工具上下文 ──────────────────────────────────────────────────────
        tool_ctx: dict = {
            "channel_id": channel_id,
            "bot_id_by_username": bot_id_by_username,
            "adapter_factory": adapter_factory,
            "create_and_broadcast": create_and_broadcast,
            "memory": memory,
            "task_id": payload.task_id,
            "sender_id": sender_id,
            "attachments": payload.attachments or [],
            "original_question_text": payload.original_question_text,
            "_db_session": pconfig.get("_db_session"),
            "_bot_id": pconfig.get("_bot_id"),
        }

        # ── 4. 加载历史消息 / 用户信息 / 回复上下文 ──────────────────────────
        chat_history: list = []
        db_session = pconfig.get("_db_session")
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
                    "unified_builtin: history=%d user=%r reply=%s channel=%s",
                    len(chat_history), current_user_name, bool(reply_prefix), channel_id,
                )
            except Exception:
                logger.warning(
                    "unified_builtin: context fetch failed channel=%s, proceeding without",
                    channel_id,
                )

        # 把回复上下文和发送者标识注入到当前用户消息
        if reply_prefix:
            user_text = reply_prefix + user_text
        if current_user_name:
            user_text = f"[{current_user_name}]: {user_text}"

        # ── 5. Agent（支持 Vision 多模态）─────────────────────────────────────
        stream_cb = pconfig.get("_stream_token")
        cfg = _get_llm_config()
        supports_vision = (cfg or {}).get("supports_vision", True) if cfg else True

        # 若有图片附件，将 file_id 注入到文本，确保 LLM 调用 edit_image 时知道 file_id
        if image_attachments:
            img_ids_note = "\n\n[系统提示] 用户本次上传了以下图片（edit_image 工具可使用这些 file_id）：\n" + "\n".join(
                f"- file_id: {a['file_id']}  文件名: {a.get('filename') or a.get('file_id')}"
                for a in image_attachments if a.get("file_id")
            )
            user_text = user_text + img_ids_note

        if supports_vision and any(a.get("image_b64") for a in image_attachments):
            user_content: str | list = _build_vision_content(user_text, image_attachments)
        else:
            if image_attachments:
                user_text += "\n\n（注：当前 LLM 未启用图片识别，已忽略图片附件。）"
            user_content = user_text

        content = await _run_agent(
            system_prompt, user_content, tool_ctx,
            stream_cb=stream_cb, history=chat_history,
        )

        # ── 5. 关键词兜底（LLM 不可用时） ─────────────────────────────────────
        if not content:
            content = (
                _build_attachment_fallback_reply(user_text, payload.attachments)
                or build_guide_content_with_form(user_text)
                or _DEFAULT_REPLY
            )
            logger.info(
                "unified_builtin: LLM unavailable, keyword fallback channel=%s msg=%s",
                channel_id,
                (user_text[:60] + "…") if len(user_text) > 60 else user_text,
            )

        # ── 6. 附加动态表单（如有匹配意图） ────────────────────────────────────
        form = get_form_for_intent(user_text)
        if form:
            content += "\n\n```guide-form\n" + json.dumps(form, ensure_ascii=False) + "\n```"

        return AgentResponse(content=content, task_id=payload.task_id, success=True)

    async def health_check(self) -> bool:
        return _get_llm_config() is not None

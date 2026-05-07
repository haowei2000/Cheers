"""帮助助手 Bot 适配器：加载 docs/help/ 下的帮助文档作为上下文，回答 AgentNexus 使用问题。"""

import logging
import re
from pathlib import Path
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from app.features.bot_runtime.adapters.base import AgentPayload, BotAdapter
from app.features.bot_runtime.pipeline.adapter_events import Delta, Final
from app.services.admin.settings_store import get_provider_for_scope

logger = logging.getLogger("app.features.bot_runtime.adapters.help_bot")

HISTORY_MSG_COUNT = 20
HISTORY_MSG_MAX_CHARS = 500

# 项目根目录（backend/app/services/adapters/ -> backend/app/services/ -> backend/app/ -> backend/ -> AgentNexus/）
_BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent
# docs/help/ 在项目根目录下（backend/ -> AgentNexus/ -> docs/help/）
_DOCS_DIR = _BACKEND_ROOT / "docs" / "help"

# 缓存加载的文档内容
_cached_docs: str | None = None


def _load_docs_from_folder() -> str:
    """从 docs/help/ 文件夹加载所有 .md 文件内容，按文件名排序拼接为字符串。

    文件名排序保证加载顺序稳定。跳过目录本身。
    """
    if not _DOCS_DIR.is_dir():
        logger.warning("help_bot: docs folder not found at %s", _DOCS_DIR)
        return ""

    parts: list[str] = []
    for path in sorted(_DOCS_DIR.rglob("*.md")):
        if path.is_file():
            try:
                content = path.read_text(encoding="utf-8")
            except Exception as e:
                logger.warning("help_bot: failed to read %s: %s", path.name, e)
                continue
            parts.append(f"=== {path.name} ===\n{content.strip()}\n")
            logger.debug("help_bot: loaded %s (%d chars)", path.name, len(content))

    if not parts:
        logger.warning("help_bot: no .md files found in %s", _DOCS_DIR)
    result = "\n\n".join(parts)
    logger.info("help_bot: loaded %d doc files, total %d chars", len(parts), len(result))
    return result


def get_help_docs() -> str:
    """获取已缓存的帮助文档内容（懒加载，首次调用时加载）。"""
    global _cached_docs
    if _cached_docs is None:
        _cached_docs = _load_docs_from_folder()
    return _cached_docs


def _get_llm_config() -> dict | None:
    """优先 channel_bot，依次回退 orchestrator / system_llm，最后回退 helper_llm_* 环境变量。"""
    from app.config import settings

    for scope in ("channel_bot", "orchestrator", "system_llm"):
        cfg = get_provider_for_scope(scope)
        if cfg and cfg.get("base_url") and cfg.get("model"):
            return cfg
    # 回退到 helper_llm_* 环境变量（无需管理界面配置即可使用）
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
        "max_tokens": min(int(cfg.get("max_tokens") or 4000), 65536),
        "streaming": True,
        "timeout": float(cfg.get("timeout", 600)),
    }
    extra_headers = cfg.get("extra_headers")
    if isinstance(extra_headers, dict):
        kwargs["default_headers"] = {str(k): str(v) for k, v in extra_headers.items()}
    return ChatOpenAI(**kwargs)


def _strip_ui_blocks(text: str) -> str:
    """移除消息中的 helper-clarify / helper-form JSON 代码块。"""
    return re.sub(r"```(?:helper-clarify|helper-form)[^`]*```", "", text, flags=re.DOTALL).strip()


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


async def _fetch_recent_history(
    session, channel_id: str, before_msg_id: str | None, limit: int = HISTORY_MSG_COUNT
) -> list:
    """从 DB 拉取最近消息，转换为 LangChain 消息列表（时间正序）。"""
    from sqlalchemy import select

    from app.db.models import Message as MsgModel

    q = select(MsgModel).where(MsgModel.channel_id == channel_id, MsgModel.content.isnot(None), MsgModel.content != "")
    if before_msg_id:
        sub = select(MsgModel.created_at).where(MsgModel.msg_id == before_msg_id).scalar_subquery()
        q = q.where(MsgModel.created_at < sub)
    q = q.order_by(MsgModel.created_at.desc()).limit(limit)
    result = await session.execute(q)
    msgs = list(result.scalars().all())
    msgs.reverse()

    display_names = await _resolve_display_names(session, msgs)

    lc_messages: list = []
    for m in msgs:
        content = _strip_ui_blocks(m.content or "")
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


async def _stream_llm(
    system_prompt: str,
    user_content: str,
    history: list | None = None,
):
    """Stream LLM tokens. Yields ``(delta_text, final_text_or_None)``. The
    last tuple has delta_text="" and final_text=accumulated content.

    Returns early with a single ``("", message)`` tuple on init failure or
    config-missing, so the caller can wrap the message into a Final event.
    """
    cfg = _get_llm_config()
    if not cfg:
        yield "", "LLM 服务未配置，无法回答。"
        return

    try:
        llm = _make_llm(cfg)
    except Exception as e:
        logger.exception("help_bot: failed to create LLM: %s", e)
        yield "", f"LLM 初始化失败：{e}"
        return

    messages: list = [
        SystemMessage(content=system_prompt),
        *(history or []),
        HumanMessage(content=user_content),
    ]

    accumulated = None
    try:
        async for chunk in llm.astream(messages):
            accumulated = chunk if accumulated is None else accumulated + chunk
            if chunk.content and isinstance(chunk.content, str):
                yield chunk.content, None
    except Exception as e:
        logger.warning("help_bot: stream error, falling back: %s", e)
        try:
            response = await llm.ainvoke(messages)
            yield "", _extract_text(response.content)
            return
        except Exception as e2:
            logger.exception("help_bot: invoke fallback failed: %s", e2)
            yield "", ""
            return
    yield "", _extract_text(accumulated.content) if accumulated is not None else ""


def _extract_text(content: Any) -> str:
    """从 LLM 响应中提取纯文本。"""
    if not content:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return " ".join(part.get("text", "") for part in content if isinstance(part, dict)).strip()
    return str(content).strip()


class HelpBotAdapter(BotAdapter):
    """帮助助手 Bot：加载 docs/help/ 下所有帮助文档，回答 AgentNexus 使用问题。"""

    async def execute(self, payload: AgentPayload):
        user_text = payload.message.text
        pconfig = payload.runtime
        channel_id = payload.channel_id
        memory = payload.context.memory or {}
        db_session = pconfig.db_session
        trigger_meta = payload.trigger_message or {}
        trigger_msg_id = trigger_meta.get("msg_id")
        sender_id = payload.message.sender_id

        # ── 加载帮助文档 ────────────────────────────────────────────────────────
        docs_content = get_help_docs()

        # ── 构建 System Prompt ────────────────────────────────────────────────
        system_prompt = "\n\n".join(
            [
                (
                    "你是 AgentNexus 的专属操作指引助手。当用户询问「如何做某事」或「怎么操作」时，"
                    "你必须给出**清晰、可操作的分步骤指引**，包含具体的按钮名称、图标、菜单位置。\n\n"
                    "## 界面关键元素速查\n"
                    "• **左侧侧边栏**：Logo、🔍搜索、🔔通知、用户头像/菜单\n"
                    "• **工作空间列表**：点击「+」创建工作空间\n"
                    "• **频道列表**：点击「+」创建频道；频道右侧「⋮」菜单管理频道\n"
                    "• **功能面板**：记忆中心（五层记忆）、好友列表、管理面板（管理员）、密钥链\n"
                    "• **顶部导航**：频道标题、在线成员数量、⚙️设置、⚡快速连接、📝摘要\n"
                    "• **底部输入区**：多行文本框、🔑密钥链按钮、➕上传文件、🔒加密发送、绿色「发送」按钮\n"
                    "• **@提及**：输入 @ 自动弹出 Bot/用户列表，用方向键选择\n"
                    "• **快捷键**：Ctrl+Enter 发送、Ctrl+K 快速搜索\n\n"
                    "## 回答格式规范（必须严格遵守）\n"
                    "当用户询问操作问题时，必须包含以下结构：\n\n"
                    "**1. 问题确认**（一句话）\n"
                    "确认用户的需求是什么\n\n"
                    "**2. 操作步骤**（核心部分）\n"
                    "用编号列表给出分步操作，每步格式：\n"
                    "  `步骤 N`：点击/进入 **[界面元素名称]**，选择/输入 **[具体内容]**\n"
                    "例如：\n"
                    "  `步骤 1`：点击左侧侧边栏的「**+**」按钮（位于频道列表下方）\n"
                    "  `步骤 2`：在弹出的输入框中输入**频道名称**\n"
                    "  `步骤 3`：选择频道类型（**公共**或**私有**）\n"
                    "  `步骤 4`：点击「**保存**」完成创建\n\n"
                    "**3. 预期结果**\n"
                    "说明操作完成后会看到什么\n\n"
                    "**4. 附加提示**（可选）\n"
                    "提醒用户注意事项或相关功能\n\n"
                    "## 其他问题回答规范\n"
                    "• **概念解释类**：用简洁的语言解释，附上相关文档链接\n"
                    "• **故障排除类**：先确认症状，再给出排查步骤\n"
                    "• **功能咨询类**：介绍功能用途，并说明在哪里找到该功能\n\n"
                    "## 禁止事项\n"
                    "• 不要说「在设置里」这种模糊描述，必须说「点击左侧的**⚙️设置图标**」\n"
                    "• 不要编造界面元素，只基于文档描述\n"
                    "• 不要给出不存在的操作路径\n"
                    "• 如文档没有明确说明，诚实告知并建议用户提供更多细节"
                ),
                (
                    "=== 帮助文档（完整参考）===\n"
                    + (docs_content if docs_content else "（文档加载失败，请检查 docs/help/ 文件夹是否存在）")
                ),
                (
                    "=== 当前频道上下文 ===\n"
                    f"【锚点】\n{memory.get('anchor') or '（暂无）'}\n\n"
                    f"【进度】\n{memory.get('progress') or '（暂无）'}\n\n"
                    f"【决策】\n{memory.get('decisions') or '（暂无）'}\n\n"
                    f"【资料索引】\n{memory.get('files_index') or '（暂无）'}\n\n"
                    f"【最近关注】\n{memory.get('recent') or '（暂无）'}"
                ),
            ]
        )

        # ── 加载历史消息 ──────────────────────────────────────────────────────
        chat_history: list = []
        current_user_name = ""

        if db_session:
            try:
                import asyncio

                # _fetch_user_display_name 定义在文件底部，Python 运行时查找不影响调用
                results = await asyncio.gather(
                    _fetch_recent_history(db_session, channel_id, trigger_msg_id),
                    _fetch_user_display_name(db_session, sender_id),
                    return_exceptions=True,
                )
                chat_history = results[0] if not isinstance(results[0], BaseException) else []
                current_user_name = results[1] if not isinstance(results[1], BaseException) else ""
            except Exception:
                logger.warning("help_bot: context fetch failed channel=%s", channel_id)

        # ── 构建用户消息 ───────────────────────────────────────────────────────
        if current_user_name:
            user_content = f"[{current_user_name}]: {user_text}"
        else:
            user_content = user_text

        # ── 调用 LLM (stream Delta tokens directly) ────────────────────────────
        full_content = ""
        async for delta_text, final_text in _stream_llm(system_prompt, user_content, history=chat_history):
            if delta_text:
                full_content += delta_text
                yield Delta(text=delta_text)
            if final_text is not None:
                full_content = final_text or full_content
                break

        if not full_content:
            full_content = (
                "抱歉，帮助助手暂时无法回答您的问题，可能是 LLM 服务不可用。"
                "您可以查看 docs/help/使用说明书.md 获取帮助，"
                "或联系管理员检查 LLM 配置。"
            )
        yield Final(content=full_content, success=True)

    async def health_check(self) -> bool:
        return _get_llm_config() is not None


async def _fetch_user_display_name(session, user_id: str) -> str:
    """获取单个用户的显示名称。"""
    if not user_id or not session:
        return ""
    from sqlalchemy import select

    from app.db.models import User

    try:
        r = await session.execute(select(User).where(User.user_id == user_id))
        u = r.scalar_one_or_none()
        return (u.display_name or u.username) if u else ""
    except Exception:
        return ""

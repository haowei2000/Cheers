"""帮助助手 Bot 适配器：加载 docs/ 下所有帮助文档作为上下文，回答 AgentNexus 使用问题。"""
import logging
import re
from pathlib import Path
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from app.services.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.services.admin.settings_store import get_provider_for_scope

logger = logging.getLogger("app.services.adapters.help_bot_adapter")

HISTORY_MSG_COUNT = 20
HISTORY_MSG_MAX_CHARS = 500

# 项目根目录（backend/app/services/adapters/ -> backend/app/services/ -> backend/app/ -> backend/）
_BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent.parent
_DOCS_DIR = _BACKEND_ROOT.parent / "docs"

# 缓存加载的文档内容
_cached_docs: str | None = None


def _load_docs_from_folder() -> str:
    """从 docs/ 文件夹加载所有 .md 文件内容，按文件名排序拼接为字符串。

    文件名排序保证加载顺序稳定。跳过目录本身。
    """
    if not _DOCS_DIR.is_dir():
        logger.warning("help_bot_adapter: docs folder not found at %s", _DOCS_DIR)
        return ""

    parts: list[str] = []
    for path in sorted(_DOCS_DIR.glob("*.md")):
        if path.is_file():
            try:
                content = path.read_text(encoding="utf-8")
            except Exception as e:
                logger.warning("help_bot_adapter: failed to read %s: %s", path.name, e)
                continue
            parts.append(f"=== {path.name} ===\n{content.strip()}\n")
            logger.debug("help_bot_adapter: loaded %s (%d chars)", path.name, len(content))

    result = "\n\n".join(parts)
    logger.info("help_bot_adapter: loaded %d doc files, total %d chars", len(parts), len(result))
    return result


def get_help_docs() -> str:
    """获取已缓存的帮助文档内容（懒加载，首次调用时加载）。"""
    global _cached_docs
    if _cached_docs is None:
        _cached_docs = _load_docs_from_folder()
    return _cached_docs


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
        "max_tokens": min(int(cfg.get("max_tokens") or 4000), 65536),
        "streaming": True,
        "timeout": float(cfg.get("timeout", 600)),
    }
    extra_headers = cfg.get("extra_headers")
    if isinstance(extra_headers, dict):
        kwargs["default_headers"] = {str(k): str(v) for k, v in extra_headers.items()}
    return ChatOpenAI(**kwargs)


def _strip_ui_blocks(text: str) -> str:
    """移除消息中的 guide-clarify / guide-form JSON 代码块。"""
    return re.sub(r"```(?:guide-clarify|guide-form)[^`]*```", "", text, flags=re.DOTALL).strip()


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


async def _fetch_recent_history(session, channel_id: str, before_msg_id: str | None, limit: int = HISTORY_MSG_COUNT) -> list:
    """从 DB 拉取最近消息，转换为 LangChain 消息列表（时间正序）。"""
    from sqlalchemy import select

    from app.db.models import Message as MsgModel

    q = select(MsgModel).where(MsgModel.channel_id == channel_id, MsgModel.content != "")
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


async def _run_llm(
    system_prompt: str,
    user_content: str,
    ctx: dict,
    stream_cb=None,
    history: list | None = None,
) -> str:
    """调用 LLM，返回文本内容（无工具调用）。"""
    cfg = _get_llm_config()
    if not cfg:
        return "LLM 服务未配置，无法回答。"

    try:
        llm = _make_llm(cfg)
    except Exception as e:
        logger.exception("help_bot_adapter: failed to create LLM: %s", e)
        return f"LLM 初始化失败：{e}"

    messages: list = [
        SystemMessage(content=system_prompt),
        *(history or []),
        HumanMessage(content=user_content),
    ]

    if stream_cb:
        accumulated = None
        try:
            async for chunk in llm.astream(messages):
                accumulated = chunk if accumulated is None else accumulated + chunk
                if chunk.content and isinstance(chunk.content, str):
                    await stream_cb(chunk.content)
        except Exception as e:
            logger.warning("help_bot_adapter: stream error, falling back: %s", e)
            try:
                response = await llm.ainvoke(messages)
                return _extract_text(response.content)
            except Exception as e2:
                logger.exception("help_bot_adapter: invoke fallback failed: %s", e2)
                return ""
        if accumulated is None:
            return ""
        return _extract_text(accumulated.content)
    else:
        try:
            response = await llm.ainvoke(messages)
            return _extract_text(response.content)
        except Exception as e:
            logger.exception("help_bot_adapter: invoke error: %s", e)
            return f"LLM 调用出错：{e}"


def _extract_text(content: Any) -> str:
    """从 LLM 响应中提取纯文本。"""
    if not content:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return " ".join(part.get("text", "") for part in content if isinstance(part, dict)).strip()
    return str(content).strip()


class HelpBotAdapter(OpenClawAdapter):
    """帮助助手 Bot：加载 docs/ 下所有文档，回答 AgentNexus 使用问题。"""

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        user_text = (payload.trigger_message or {}).get("text", "") or ""
        pconfig = payload.process_config or {}
        channel_id = payload.channel_id
        memory = payload.memory_context or {}
        db_session = pconfig.get("_db_session")
        stream_cb = pconfig.get("_stream_token")
        trigger_meta = payload.trigger_message or {}
        trigger_msg_id = trigger_meta.get("msg_id")
        sender_id = trigger_meta.get("user", "")

        # ── 加载帮助文档 ────────────────────────────────────────────────────────
        docs_content = get_help_docs()

        # ── 构建 System Prompt ────────────────────────────────────────────────
        system_prompt = "\n\n".join([
            "你是 AgentNexus 的专属帮助助手，专注于回答用户关于 AgentNexus 平台的使用问题。"
            "你有权限访问 AgentNexus 的完整帮助文档（见下方「=== 帮助文档 ===」），请基于这些文档准确回答。"
            "如果用户问题不在文档范围内，请诚实说明，并建议用户提供更多细节。",
            "=== 帮助文档 ===\n" + (docs_content if docs_content else "（文档加载失败，请检查 docs/ 文件夹是否存在）"),
            (
                "=== 当前频道记忆 ===\n"
                f"【锚点】\n{memory.get('anchor') or '（暂无）'}\n\n"
                f"【进度】\n{memory.get('progress') or '（暂无）'}\n\n"
                f"【决策】\n{memory.get('decisions') or '（暂无）'}\n\n"
                f"【最近关注】\n{memory.get('recent') or '（暂无）'}"
            ),
            (
                "## 回答准则\n\n"
                "- 回答时优先引用具体文档与章节，例如「详见《系统管理说明书》§二」\n"
                "- 使用 Markdown 格式，结构清晰\n"
                "- 如需给用户提供可操作的步骤，请分点说明\n"
                "- 如用户问题不明确，可以反问以澄清需求\n"
                "- 不要胡乱猜测，只基于文档内容和对话上下文回答\n"
                "- 如果文档中有链接，请以 Markdown 链接形式给出"
            ),
        ])

        # ── 加载历史消息 ──────────────────────────────────────────────────────
        chat_history: list = []
        current_user_name = ""

        if db_session:
            try:
                import asyncio
                results = await asyncio.gather(
                    _fetch_recent_history(db_session, channel_id, trigger_msg_id),
                    _fetch_user_display_name(db_session, sender_id),
                    return_exceptions=True,
                )
                chat_history = results[0] if not isinstance(results[0], BaseException) else []
                current_user_name = results[1] if not isinstance(results[1], BaseException) else ""
            except Exception:
                logger.warning("help_bot_adapter: context fetch failed channel=%s", channel_id)

        # ── 构建用户消息 ───────────────────────────────────────────────────────
        if current_user_name:
            user_content = f"[{current_user_name}]: {user_text}"
        else:
            user_content = user_text

        # ── 调用 LLM ───────────────────────────────────────────────────────────
        content = await _run_llm(system_prompt, user_content, {}, stream_cb=stream_cb, history=chat_history)

        if not content:
            content = (
                "抱歉，帮助助手暂时无法回答您的问题，可能是 LLM 服务不可用。"
                "您可以查看 /manual/使用说明书 获取帮助，"
                "或联系管理员检查 LLM 配置。"
            )

        return AgentResponse(content=content, task_id=payload.task_id, success=True)

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

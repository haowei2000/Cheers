"""Helper module."""

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

# Project root path from this adapter module.
_BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent
# docs/help lives under the project root.
_DOCS_DIR = _BACKEND_ROOT / "docs" / "help"

# Cache loaded documentation content.
_cached_docs: str | None = None


def _load_docs_from_folder() -> str:
    """Load docs from folder."""
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
    """Get help docs."""
    global _cached_docs
    if _cached_docs is None:
        _cached_docs = _load_docs_from_folder()
    return _cached_docs


def _get_llm_config() -> dict | None:
    """
Resolve LLM configuration, preferring channel_bot, then orchestrator, then system_llm, then
helper_llm environment variables.
    """
    from app.config import settings

    for scope in ("channel_bot", "orchestrator", "system_llm"):
        cfg = get_provider_for_scope(scope)
        if cfg and cfg.get("base_url") and cfg.get("model"):
            return cfg
    # Fall back to helper_llm_* environment variables when admin settings are absent.
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
    """Build a ChatOpenAI instance from provider configuration."""
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
    """Remove helper-clarify and helper-form JSON code blocks before sending content to the LLM."""
    return re.sub(r"```(?:helper-clarify|helper-form)[^`]*```", "", text, flags=re.DOTALL).strip()


async def _resolve_display_names(session, msgs: list) -> dict[str, str]:
    """Resolve display names for all message senders in a batch."""
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
    """Fetch recent non-empty messages before the trigger message and convert them into LangChain messages."""
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
    """Extract text."""
    if not content:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return " ".join(part.get("text", "") for part in content if isinstance(part, dict)).strip()
    return str(content).strip()


class HelpBotAdapter(BotAdapter):
    """Help Bot Adapter schema or model."""

    async def execute(self, payload: AgentPayload):
        user_text = payload.message.text
        pconfig = payload.runtime
        channel_id = payload.channel_id
        memory = payload.context.memory or {}
        db_session = pconfig.db_session
        trigger_meta = payload.trigger_message or {}
        trigger_msg_id = trigger_meta.get("msg_id")
        sender_id = payload.message.sender_id

        # Load help documents.
        docs_content = get_help_docs()

        # Build the system prompt.
        system_prompt = "\n\n".join(
            [
                (
                    "You are AgentNexus's dedicated operation-guide assistant. When the user asks how to do something, "
                    "provide clear, actionable step-by-step guidance with concrete button names, icons, and menu locations.\n\n"
                    "## Interface Quick Reference\n"
                    "• **Left sidebar**: logo, search, notifications, user avatar/menu\n"
                    "• **Workspace list**: click + to create a workspace\n"
                    "• **Channel list**: click + to create a channel; use the channel ⋮ menu for channel management\n"
                    "• **Panels**: memory center, friends list, admin panel, keychain\n"
                    "• **Top navigation**: channel title, online member count, settings, quick connect, summary\n"
                    "• **Composer**: multiline input, keychain button, upload button, encrypted send, Send button\n"
                    "• **Mentions**: type @ to open the Bot/user picker and use arrow keys to choose\n"
                    "• **Shortcuts**: Ctrl+Enter to send, Ctrl+K for quick search\n\n"
                    "## Required Answer Format\n"
                    "When answering operation questions, use this structure:\n\n"
                    "**1. Confirm the request** in one sentence.\n\n"
                    "**2. Steps** as a numbered list. Each step should follow this style:\n"
                    "  `Step N`: click/open **[UI element]**, then choose/type **[specific content]**\n\n"
                    "**3. Expected result**: explain what the user should see after completion.\n\n"
                    "**4. Extra tips** if relevant.\n\n"
                    "## Other Answer Types\n"
                    "• **Concept explanations**: explain briefly and include related documentation links.\n"
                    "• **Troubleshooting**: confirm the symptom first, then provide checks.\n"
                    "• **Feature questions**: explain what the feature does and where to find it.\n\n"
                    "## Do Not\n"
                    "• Do not use vague directions like 'in settings'; name the specific UI element.\n"
                    "• Do not invent UI elements.\n"
                    "• Do not provide nonexistent operation paths.\n"
                    "• If the documentation is unclear, say so and ask for more details."
                ),
                (
                    "=== Help Documents (Full Reference) ===\n"
                    + (docs_content if docs_content else "(Documents failed to load; check whether docs/help/ exists.)")
                ),
                (
                    "=== Current Channel Context ===\n"
                    f"[Anchor]\n{memory.get('anchor') or '(none)'}\n\n"
                    f"[Progress]\n{memory.get('progress') or '(none)'}\n\n"
                    f"[Decisions]\n{memory.get('decisions') or '(none)'}\n\n"
                    f"[File Index]\n{memory.get('files_index') or '(none)'}\n\n"
                    f"[Recent Focus]\n{memory.get('recent') or '(none)'}"
                ),
            ]
        )

        # Load message history.
        chat_history: list = []
        current_user_name = ""

        if db_session:
            try:
                import asyncio

                # _fetch_user_display_name is defined later; runtime lookup still resolves it.
                results = await asyncio.gather(
                    _fetch_recent_history(db_session, channel_id, trigger_msg_id),
                    _fetch_user_display_name(db_session, sender_id),
                    return_exceptions=True,
                )
                chat_history = results[0] if not isinstance(results[0], BaseException) else []
                current_user_name = results[1] if not isinstance(results[1], BaseException) else ""
            except Exception:
                logger.warning("help_bot: context fetch failed channel=%s", channel_id)

        # Build the user message.
        if current_user_name:
            user_content = f"[{current_user_name}]: {user_text}"
        else:
            user_content = user_text

        # Call the LLM and stream delta tokens directly.
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
    """Fetch one user display name and return an empty string on failure."""
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

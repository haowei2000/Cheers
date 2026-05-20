"""Built-in channel coordinator Bot adapter backed by a LangChain agent and tools."""

import json
import logging
import re
from typing import Any, cast
from xml.sax.saxutils import escape, quoteattr

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

from app.core.localization import is_zh, localized, normalize_locale
from app.features.bot_runtime.adapters.base import AgentPayload, BotAdapter
from app.features.bot_runtime.adapters.help_catalog import (
    build_help_content_with_form,
    get_help_context_for_llm,
)
from app.features.bot_runtime.coordinator_profile import (
    ALL_COORDINATOR_TOOLS,
    CoordinatorContextProfile,
    build_coordinator_profile,
)
from app.features.memory.prompt_xml import MEMORY_LAYER_FIELDS, render_channel_memory_xml
from app.services.admin.settings_store import get_provider_for_scope

logger = logging.getLogger("app.features.bot_runtime.adapters.channel_bot")

MAX_LOOP_ITERATIONS = 8
HISTORY_MSG_COUNT = 30  # Maximum number of history messages injected into the LLM.
HISTORY_MSG_MAX_CHARS = 600  # Maximum characters retained from each history message.
_CLARIFY_PREFIXES = (
    "@Coordinator 澄清回答：",
    "@Helper 澄清回答：",
    "@引导 澄清回答：",
    "@channel bot 澄清回答：",
    "@Coordinator clarification answer:",
    "@Helper clarification answer:",
    "@channel bot clarification answer:",
)

_DEFAULT_REPLY_ZH = (
    "您可以说：怎么创建项目、怎么加入项目、怎么接入外部 Agent、怎么发消息、"
    "左边没有项目、@ 没反应、怎么安装、报错排查 等，我会根据说明书为您引导。"
    "也可以直接问项目相关问题，我会结合频道上下文回答。"
)
_DEFAULT_REPLY_EN = (
    "You can ask how to create a project, join a project, connect an external Agent, send messages, "
    "fix an empty left sidebar, troubleshoot @ mentions, install/deploy, or diagnose errors. "
    "You can also ask project-specific questions and I will answer using the channel context."
)


_MEMORY_XML_FIELDS = MEMORY_LAYER_FIELDS

_MEMORY_LAYER_CHAR_BUDGETS = {
    "anchor": 1600,
    "progress": 1400,
    "decisions": 1600,
    "files_index": 2200,
    "history": 1800,
    "todos": 1200,
}


def _t(locale: str | None, en: str, zh: str) -> str:
    return localized(locale, en=en, zh=zh)


def _default_reply(locale: str | None) -> str:
    return _t(locale, _DEFAULT_REPLY_EN, _DEFAULT_REPLY_ZH)


def _strip_matching_prefix(text: str, prefixes: tuple[str, ...]) -> tuple[bool, str]:
    stripped = (text or "").strip()
    for prefix in prefixes:
        if stripped.startswith(prefix):
            return True, stripped[len(prefix):].strip()
    return False, stripped


def _clip_text(text: str, limit: int) -> str:
    text = (text or "").strip()
    if limit <= 0 or len(text) <= limit:
        return text
    return text[:limit].rstrip() + "\n...[truncated]"


def _trim_memory_for_profile(
    memory: dict[str, str],
    profile: CoordinatorContextProfile,
) -> dict[str, str]:
    if not profile.memory_layers or profile.memory_char_budget <= 0:
        return {}

    remaining = profile.memory_char_budget
    trimmed: dict[str, str] = {}
    for key, _label in MEMORY_LAYER_FIELDS:
        if key not in profile.memory_layers:
            continue
        content = (memory.get(key) or "").strip()
        if key == "history" and not content:
            content = (memory.get("recent") or "").strip()
        if not content:
            continue
        layer_budget = min(_MEMORY_LAYER_CHAR_BUDGETS.get(key, 1200), remaining)
        if layer_budget <= 0:
            break
        clipped = _clip_text(content, layer_budget)
        trimmed[key] = clipped
        remaining -= len(clipped)
    return trimmed


def _build_behavior_rules(profile: CoordinatorContextProfile, locale: str | None = None) -> str:
    if is_zh(locale):
        rules = [
            "## 核心行为规则",
            "",
            "- 最终回复使用简洁、专业的 Markdown。",
            "- 先给出你能给出的最佳答案，再补充需要确认的关键假设。宁可基于合理假设给出方案，也不要只追问不给答案。",
            "- 只基于本提示词包含的上下文回答。若关键信息缺失，明确说明你的假设是什么。",
        ]
        if "call_user" in profile.enabled_tools:
            rules.append("- call_user 仅在需要关键决策（如授权、选型确认）且已有方案的情况下使用。不要用 call_user 代替回答。")
        if "call_bot" in profile.enabled_tools:
            rules.append("- 当频道内其他 Bot 更适合处理时，使用 call_bot 派发聚焦的子任务。")
        if "read_file" in profile.enabled_tools:
            rules.append("- 对上传文档优先使用文件引用；只有需要正文时再调用 read_file。")
        if {"web_fetch", "web_search"} & profile.enabled_tools:
            rules.append("- 只有当答案依赖实时或外部网页信息时才使用网页工具。")
        if {"update_anchor", "update_progress", "update_decision"} & profile.enabled_tools:
            rules.extend([
                "",
                "## 记忆维护职责",
                "",
                "- 当项目目标、范围、约束或背景变化时调用 update_anchor。",
                "- 当用户报告进展、阻塞、里程碑或下一步时调用 update_progress。",
                "- 对重要决策、技术选择和确认计划调用 update_decision。",
                "- 只有存在具体的新信息需要持久化时才调用记忆工具。",
            ])
        if profile.intent == "help":
            rules.extend([
                "",
                "## 帮助回答规则",
                "",
                "- 操作类问题要给出具体 UI 入口和简短编号步骤。",
                "- 如果帮助上下文没有覆盖精确问题，说明这一点并给出最接近的安全路径。",
            ])
        if profile.intent == "project":
            rules.extend([
                "",
                "## 项目对话规则",
                "",
                "- 直接给出具体建议、方案或分析，不要用提问代替回答。",
                "- 如果确实需要更多信息才能给出准确答案，用一句话追问，同时先给出基于现有信息的初步建议。",
            ])

    rules = [
        "## Core Behavior Rules",
        "",
        "- Final replies should be concise, professional Markdown.",
        "- Use only the context included in this prompt. If important context is missing, say what is missing.",
    ]
    if "call_user" in profile.enabled_tools:
        rules.append("- If the user message lacks enough information or needs a key decision, call call_user before guessing.")
    if "call_bot" in profile.enabled_tools:
        rules.append("- When another channel Bot is better suited, call call_bot with a focused delegated task.")
    if "read_file" in profile.enabled_tools:
        rules.append("- For uploaded documents, use file references first and call read_file only when the body is needed.")
    if {"web_fetch", "web_search"} & profile.enabled_tools:
        rules.append("- Use web tools only when the answer depends on current or external web information.")
    if {"update_anchor", "update_progress", "update_decision"} & profile.enabled_tools:
        rules.extend([
            "",
            "## Memory Maintenance Duties",
            "",
            "- update_anchor when project goals, scope, constraints, or background change.",
            "- update_progress when the user reports progress, blockers, milestones, or next steps.",
            "- update_decision for important decisions, technology choices, and confirmed plans.",
            "- Call memory tools only when there is concrete new information to persist.",
        ])
    if profile.intent == "help":
        rules.extend([
            "",
            "## Help Answer Rules",
            "",
            "- Answer operation questions with concrete UI entry points and short numbered steps.",
            "- If the help context does not cover the exact request, say so and give the closest safe path.",
        ])
    return "\n".join(rules)


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
    """
Resolve LLM configuration, preferring channel_bot, then orchestrator, then system_llm, then
helper_llm environment variables.
    """
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
    """Build a ChatOpenAI instance from provider configuration."""
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


def _tool_label(tool_name: str, args: dict, locale: str | None = None) -> str:
    """Human-readable label for a tool call notification."""
    args = args or {}
    match tool_name:
        case "call_bot":
            return _t(locale, f"Call @{args.get('username', '?')}", f"调用 @{args.get('username', '?')}")
        case "update_anchor":
            return _t(locale, "Update project anchor", "更新项目锚点")
        case "update_decision":
            return _t(locale, "Record decision", "记录决策")
        case "update_progress":
            return _t(locale, "Update project progress", "更新项目进度")
        case "call_user":
            return _t(locale, f"Call @{args.get('username', '?')}", f"呼叫 @{args.get('username', '?')}")
        case "create_file":
            filename = args.get("filename") or "?"
            return _t(locale, f"Create file {filename}.md", f"创建文件 {filename}.md")
        case "read_file":
            file_id = args.get("file_id") or "?"
            preview = (file_id[:8] + "…") if len(file_id) > 8 else file_id
            return _t(locale, f"Read file {preview}", f"读取文件 {preview}")
        case "web_fetch":
            url = args.get("url") or "?"
            suffix = "..." if len(url) > 50 else ""
            return _t(locale, f"Fetch web page: {url[:50]}{suffix}", f"获取网页：{url[:50]}{suffix}")
        case "web_search":
            query = args.get("query") or "?"
            suffix = "..." if len(query) > 40 else ""
            return _t(locale, f"Search: {query[:40]}{suffix}", f"搜索：{query[:40]}{suffix}")
        case _:
            return tool_name


# Tool factories.


def _make_tools(ctx: dict, enabled_tool_names: frozenset[str] | set[str] | None = None) -> list:
    """Make tools."""
    locale = normalize_locale(ctx.get("locale"))

    @tool
    async def update_anchor(content: str) -> str:
        """
Update the project anchor memory layer by replacing its content.

Args:
    content: Complete replacement content for the anchor layer.
        """
        if not content.strip():
            return _t(locale, "Error: content cannot be empty", "错误：content 不能为空")
        from app.features.memory.manager import save_layer

        await save_layer(ctx["channel_id"], "anchor", content.strip())
        logger.info(
            "channel_bot[tool]: update_anchor channel=%s len=%d",
            ctx["channel_id"],
            len(content),
        )
        return _t(locale, "Project anchor updated", "已更新项目锚点")

    @tool
    async def update_progress(content: str) -> str:
        """
Update the project progress memory layer by replacing its content.

Args:
    content: Current progress, completed work, and next steps.
        """
        if not content.strip():
            return _t(locale, "Error: content cannot be empty", "错误：content 不能为空")
        from app.features.memory.manager import save_layer

        await save_layer(ctx["channel_id"], "progress", content.strip())
        logger.info(
            "channel_bot[tool]: update_progress channel=%s len=%d",
            ctx["channel_id"],
            len(content),
        )
        return _t(locale, "Project progress updated", "已更新项目进度")

    @tool
    async def update_decision(content: str) -> str:
        """
Record important decisions in the decisions memory layer.

Args:
    content: Replacement decision record content.
        """
        if not content.strip():
            return _t(locale, "Error: content cannot be empty", "错误：content 不能为空")
        from app.features.memory.manager import save_layer

        await save_layer(ctx["channel_id"], "decisions", content.strip())
        logger.info(
            "channel_bot[tool]: update_decision channel=%s len=%d",
            ctx["channel_id"],
            len(content),
        )
        return _t(locale, "Decision records updated", "已更新决策记录")

    @tool
    async def call_bot(username: str, message: str) -> str:
        """
Delegate a subtask to a specialist Bot in the current channel.

Args:
    username: Bot username without the at sign.
    message: Task description sent to that Bot.
        """
        from app.features.bot_runtime.pipeline.bot import Capabilities, dispatch_one

        username = username.strip().lstrip("@")
        message = message.strip()
        if not username or not message:
            return _t(locale, "Error: username and message are required", "错误：需要提供 username 和 message")

        run_ctx = ctx.get("_run_ctx")
        if run_ctx is None:
            return _t(locale, "Error: _run_ctx was not injected (internal error)", "错误：_run_ctx 未注入（内部错误）")

        bot_id = run_ctx.bot_id_by_username.get(username)
        if bot_id is None:
            available = list(run_ctx.bot_id_by_username.keys())
            return _t(
                locale,
                f"Error: @{username} is not in this channel. Available Bots: {available}",
                f"错误：频道内没有 @{username}，可用 Bot：{available}",
            )

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
                return _t(locale, f"@{username} call failed (async dispatch or error)", f"@{username} 调用失败（异步派发或错误）")
            result = resp.content if resp.success else (resp.error_message or _t(locale, "Bot execution failed", "Bot 执行出错"))
            logger.info(
                "channel_bot[tool]: call_bot @%s completed channel=%s",
                username,
                run_ctx.channel_id,
            )
            return _t(locale, f"@{username} reply:\n{result}", f"@{username} 回复：\n{result}")
        except Exception as e:
            logger.exception("channel_bot[tool]: call_bot @%s failed: %s", username, e)
            return _t(locale, f"@{username} call error: {e}", f"@{username} 调用出错：{e}")

    @tool(return_direct=True)
    async def call_user(
        username: str,
        message: str,
        options: list[str] | str | None = None,
        questions: list[dict[str, Any]] | str | None = None,
        allow_multiple: bool = False,
        allow_manual: bool = False,
        manual_label: str = "Other (manual input)",
        manual_placeholder: str = "Enter your answer...",
    ) -> str:
        """
Mention a user, optionally ask a multiple-choice question, and pause for the user's answer.

Use username and message for a notification. Provide at least two options to render a choice UI
and wait for the answer.

Args:
    username: Username without the at sign, usually obtained from conversation history.
    message: Message or question sent to the user.
    options: Choice list, JSON array string, or empty for notification-only mode.
    allow_multiple: Whether multiple choices are allowed.
    allow_manual: Whether freeform manual input is allowed.
    manual_label: Label for the manual-input option.
    manual_placeholder: Placeholder for the manual-input field.
        """
        username = (username or "").strip().lstrip("@")
        message = (message or "").strip()
        if not username or not message:
            return _t(locale, "Error: username and message are required", "错误：需要提供 username 和 message")

        default_manual_label = _t(locale, "Other (manual input)", "其他（手动输入）")
        default_manual_placeholder = _t(locale, "Enter your answer...", "请输入您的回答...")
        if manual_label in {"Other (manual input)", "其他（手动输入）", ""}:
            manual_label = default_manual_label
        if manual_placeholder in {"Enter your answer...", "请输入您的回答...", ""}:
            manual_placeholder = default_manual_placeholder

        # Be tolerant of questions arriving as a JSON string.
        parsed_questions: list[dict[str, Any]] = []
        if isinstance(questions, str) and questions.strip().startswith("["):
            try:
                parsed = json.loads(questions)
                if isinstance(parsed, list):
                    parsed_questions = [q for q in parsed if isinstance(q, dict)]
            except (json.JSONDecodeError, TypeError):
                pass
        elif isinstance(questions, list):
            parsed_questions = [q for q in questions if isinstance(q, dict)]

        if parsed_questions:
            built_questions: list[dict[str, Any]] = []
            for idx, q in enumerate(parsed_questions):
                prompt = (q.get("prompt") or q.get("question") or "").strip()
                if not prompt:
                    continue
                q_options = q.get("options") or []
                if isinstance(q_options, str) and q_options.strip().startswith("["):
                    try:
                        parsed = json.loads(q_options)
                        if isinstance(parsed, list):
                            q_options = parsed
                    except (json.JSONDecodeError, TypeError):
                        q_options = []
                if isinstance(q_options, str) and q_options.strip():
                    q_options = [q_options.strip()]
                if not isinstance(q_options, list) or len(q_options) < 2:
                    return _t(locale, "Error: each question must have at least 2 choices", "错误：每个问题至少需要 2 个选项")
                option_items: list[dict[str, Any]] = []
                for opt in q_options:
                    if isinstance(opt, dict):
                        label = str(opt.get("label") or opt.get("text") or "").strip()
                        if not label:
                            continue
                        option_items.append({
                            "id": str(opt.get("id") or f"a{len(option_items)}"),
                            "label": label,
                            "requires_text": bool(opt.get("requires_text")),
                            "text_placeholder": opt.get("text_placeholder"),
                        })
                    else:
                        option_items.append({"id": f"a{len(option_items)}", "label": str(opt)})
                q_allow_manual = bool(q.get("allow_manual", allow_manual))
                q_other_label = q.get("other_label") or manual_label
                q_other_placeholder = q.get("other_placeholder") or manual_placeholder
                built_questions.append({
                    "id": str(q.get("id") or f"q{idx}"),
                    "prompt": prompt,
                    "allow_multiple": bool(q.get("allow_multiple", allow_multiple)),
                    "options": option_items,
                    "other_enabled": q_allow_manual,
                    "other_label": q_other_label,
                    "other_placeholder": q_other_placeholder,
                })
            if not built_questions:
                return _t(locale, "Error: questions must include prompts and options", "错误：questions 需要包含问题和选项")
            clarify_schema = {
                "title": _t(locale, "Please confirm the following questions", "请确认以下问题"),
                "skip_policy": "allow",
                "questions": built_questions,
            }
            clarify_block = "```helper-clarify\n" + json.dumps(clarify_schema, ensure_ascii=False) + "\n```"
            return clarify_block

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
            return _t(locale, "Error: options must contain at least 2 choices", "错误：options 至少需要 2 个选项")

        clarify_schema = {
            "title": _t(locale, "Please confirm the following question", "请确认以下问题"),
            "skip_policy": "allow",
            "questions": [
                {
                    "id": "q0",
                    "prompt": message,
                    "allow_multiple": allow_multiple,
                    "options": [{"id": f"a{i}", "label": str(opt)} for i, opt in enumerate(options)],
                    "other_enabled": allow_manual,
                    "other_label": manual_label or default_manual_label,
                    "other_placeholder": manual_placeholder or default_manual_placeholder,
                }
            ],
        }
        clarify_block = "```helper-clarify\n" + json.dumps(clarify_schema, ensure_ascii=False) + "\n```"
        return clarify_block

    @tool
    async def create_file(filename: str, content: str) -> str:
        """
Save content as a Markdown file and return a preview link.

Args:
    filename: File name without an extension.
    content: Complete Markdown body.
        """
        import uuid
        from datetime import datetime, timezone
        from pathlib import Path

        safe_name = re.sub(r"[^\w\-. ]", "_", filename.strip()) or "output"
        body = content.strip()
        if not body:
            return _t(locale, "Error: content cannot be empty", "错误：content 不能为空")

        from app.config import settings
        from app.db.models import Channel, FileRecord
        from app.services.file_retention import file_expires_at
        from app.services.file_scope_service import FileScopeService

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

        db_session = ctx.get("_db_session")
        channel = await db_session.get(Channel, channel_id) if db_session else None

        record = FileRecord(
            file_id=file_id,
            channel_id=channel_id,
            workspace_id=channel.workspace_id if channel else None,
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
        if db_session:
            db_session.add(record)
            await db_session.flush()
            if channel:
                await FileScopeService(db_session).link_file_to_channel(
                    record, channel, created_by=ctx.get("sender_id") or "system"
                )
        else:
            from app.db.session import async_session_factory

            async with async_session_factory() as s:
                channel = await s.get(Channel, channel_id)
                if channel:
                    record.workspace_id = channel.workspace_id
                s.add(record)
                await s.flush()
                if channel:
                    await FileScopeService(s).link_file_to_channel(
                        record, channel, created_by=ctx.get("sender_id") or "system"
                    )
                await s.commit()

        preview_url = f"/api/v1/files/{file_id}/preview"
        logger.info(
            "channel_bot[tool]: create_file %s channel=%s",
            original_filename,
            channel_id,
        )

        # Collect file_ids so they can be attached to the final bot reply.
        ctx.setdefault("_created_file_ids", []).append(file_id)

        return _t(
            locale,
            f"File created: [{original_filename}]({preview_url})\n\nPreview URL: `{preview_url}`",
            f"文件已创建：[{original_filename}]({preview_url})\n\n预览链接：`{preview_url}`",
        )

    @tool
    async def read_file(file_id: str) -> str:
        """
Read the full converted text of an uploaded file in the current channel.

Use this when a user references a file or the file index lists a file whose content must be
inspected.

Args:
    file_id: Unique file ID, usually a UUID.
        """
        db_session = ctx.get("_db_session")
        if not db_session:
            return _t(locale, "Error: database session was not injected (internal error)", "错误：数据库会话未注入（内部错误）")

        from app.services.file_processor.service import FileFlowError, FilePipelineService

        try:
            svc = FilePipelineService()
            results = await svc.prepare_attachments(
                db_session,
                channel_id=ctx["channel_id"],
                file_ids=[file_id.strip()],
            )
        except FileFlowError as exc:
            return _t(locale, f"Failed to read file: {exc.detail}", f"读取文件失败：{exc.detail}")
        except Exception as exc:
            logger.exception("channel_bot[tool]: read_file error file_id=%s", file_id)
            return _t(locale, f"File read error: {exc}", f"读取文件出错：{exc}")

        if not results:
            return _t(
                locale,
                f"No file found for file_id={file_id!r}. Check whether the file_id in the file index is correct.",
                f"未找到 file_id={file_id!r} 的文件，请检查文件索引中的 file_id 是否正确",
            )

        att = results[0]
        if att.get("is_image") == "true":
            return _t(
                locale,
                f"File \"{att.get('filename')}\" is an image. View the image attachment directly; no text read is needed.",
                f"文件「{att.get('filename')}」是图片，请直接查看图片附件，无需读取文本。",
            )

        parts = [f"=== {_t(locale, 'File', '文件')}: {att.get('filename') or file_id} ==="]
        if att.get("summary"):
            parts.append(f"{_t(locale, 'Summary', '摘要')}: {att['summary']}")
        content = (att.get("content") or "").strip()
        if content:
            parts.append(_t(locale, "Body:", "正文:"))
            parts.append(content)
            if att.get("truncated") == "true":
                parts.append(_t(locale, "(Note: file content was truncated by length limit. Contact the uploader if the full content is needed.)", "（注：文件内容已按长度限制截断，若需完整内容请联系上传者。）"))
        else:
            parts.append(_t(locale, "(The file is empty or text could not be parsed.)", "（文件内容为空或无法解析文本。）"))
        return "\n".join(parts)

    @tool
    async def create_todo(content: str, assignee_username: str | None = None) -> str:
        """
Create a todo item in the current channel and optionally assign it.

Args:
    content: Todo description.
    assignee_username: Optional username without the at sign.
        """
        db_session = ctx.get("_db_session")
        if not db_session:
            return _t(locale, "Error: database session was not injected", "错误：数据库会话未注入")

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
                    return _t(locale, f"Error: no user or Bot named {username} was found.", f"错误：找不到名为 {username} 的用户或Bot。")

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
        return _t(locale, "Todo created.", "成功创建待办事项！")

    @tool
    async def list_todos() -> str:
        """List all todo items in the current channel with index, status, content, and assignee."""
        db_session = ctx.get("_db_session")
        if not db_session:
            return _t(locale, "Error: database session was not injected", "错误：数据库会话未注入")
        from sqlalchemy import select

        from app.db.models import TodoItem

        result = await db_session.execute(
            select(TodoItem).where(TodoItem.channel_id == ctx["channel_id"]).order_by(TodoItem.created_at)
        )
        todos = result.scalars().all()
        if not todos:
            return _t(locale, "There are no todos in the current channel.", "当前频道没有待办事项。")
        lines = []
        for i, t in enumerate(todos, 1):
            status = "✅" if t.status == "completed" else "⬜"
            assignee = (
                _t(locale, f" (assigned to: {t.assignee_id})", f"（指派给：{t.assignee_id}）")
                if t.assignee_id
                else ""
            )
            lines.append(f"{i}. {status} {t.content}{assignee}")
        return "\n".join(lines)

    @tool
    async def update_todo(
        content_keyword: str,
        new_content: str | None = None,
        status: str | None = None,
        assignee_username: str | None = None,
    ) -> str:
        """
Update a todo item in the current channel that matches a keyword.

Args:
    content_keyword: Keyword used to find a todo by substring match.
    new_content: Optional replacement content.
    status: Optional new status, either "pending" or "completed".
    assignee_username: Optional username without the at sign; an empty string clears assignment.
        """
        db_session = ctx.get("_db_session")
        if not db_session:
            return _t(locale, "Error: database session was not injected", "错误：数据库会话未注入")
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
            return _t(locale, f"Error: no todo containing '{content_keyword}' was found.", f"错误：找不到包含'{content_keyword}'的待办事项。")
        if len(matches) > 1:
            preview = "、".join(f"'{t.content}'" for t in matches[:5])
            return _t(
                locale,
                f"Error: keyword '{content_keyword}' matched multiple todos ({preview}). Provide a more specific keyword.",
                f"错误：关键词'{content_keyword}'匹配到多条（{preview}），请提供更精确的关键词。",
            )
        todo = matches[0]
        if new_content is not None:
            todo.content = new_content
        if status is not None:
            if status not in ("pending", "completed"):
                return _t(locale, "Error: status must be 'pending' or 'completed'.", "错误：status 只能是 'pending' 或 'completed'。")
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
                        return _t(locale, f"Error: no user or Bot named {username} was found.", f"错误：找不到名为 {username} 的用户或Bot。")
        await db_session.commit()
        return _t(locale, f"Todo updated: '{todo.content}'", f"成功更新待办事项：'{todo.content}'")

    @tool
    async def delete_todo(content_keyword: str) -> str:
        """
Delete a todo item in the current channel that matches a keyword.

Args:
    content_keyword: Keyword used to find a todo by substring match.
        """
        db_session = ctx.get("_db_session")
        if not db_session:
            return _t(locale, "Error: database session was not injected", "错误：数据库会话未注入")
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
            return _t(locale, f"Error: no todo containing '{content_keyword}' was found.", f"错误：找不到包含'{content_keyword}'的待办事项。")
        if len(matches) > 1:
            preview = "、".join(f"'{t.content}'" for t in matches[:5])
            return _t(
                locale,
                f"Error: keyword '{content_keyword}' matched multiple todos ({preview}). Provide a more specific keyword.",
                f"错误：关键词'{content_keyword}'匹配到多条（{preview}），请提供更精确的关键词。",
            )
        todo = matches[0]
        content = todo.content
        await db_session.delete(todo)
        await db_session.commit()
        return _t(locale, f"Todo deleted: '{content}'", f"成功删除待办事项：'{content}'")

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

    tools = [
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
    if enabled_tool_names is None:
        return tools
    enabled = set(enabled_tool_names) & ALL_COORDINATOR_TOOLS
    return [item for item in tools if item.name in enabled]


# Attachment handling.


def _build_file_refs_note(attachments: list[dict[str, str]] | None, locale: str | None = None) -> str:
    """Build a compact attachment reference note for documents without injecting file bodies."""
    if not attachments:
        return ""
    lines = [
        _t(
            locale,
            "[This message has the following linked files. They are recorded in the file index; call read_file if the content is needed.]",
            "[本次消息关联以下文件，已登记到文件索引，如需查看内容请调用 read_file 工具]",
        )
    ]
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
    """Build OpenAI Vision multimodal content from text and image attachments."""
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


def _build_attachment_fallback_reply(user_text: str, attachments: list[dict[str, str]] | None, locale: str | None = None) -> str:
    """Build a fallback reply from parsed attachment content when the LLM is unavailable."""
    if not attachments:
        return ""
    normalized = (user_text or "").lower()
    wants_summary = any(kw in normalized for kw in ("概括", "摘要", "总结", "概述", "summary", "summar"))
    sections = [
        _t(
            locale,
            "The LLM service is currently unavailable, but I was able to read the uploaded file content.",
            "当前 LLM 服务暂时不可用，但我已经成功读取了上传文件内容。",
        )
    ]
    for index, attachment in enumerate(attachments, start=1):
        filename = attachment.get("filename") or attachment.get("file_id") or f"文件 {index}"
        summary = (attachment.get("summary") or "").strip()
        content = (attachment.get("content") or "").strip()
        excerpt = content[:280].strip()
        if len(content) > 280:
            excerpt += "..."
        sections.append(f"### File {index}: {filename}")
        if wants_summary:
            sections.append(_t(locale, "Summary based on parsed text:", "基于已解析文本的概括："))
            if summary:
                sections.append(summary)
            elif excerpt:
                sections.append(f"- {excerpt}")
            else:
                sections.append(_t(locale, "- The file was read, but no extractable text is available yet.", "- 文件已读取，但暂时没有可提取的文本内容。"))
        else:
            if summary:
                sections.append(_t(locale, "Key content extracted from the file:", "我先提取出文件的关键内容："))
                sections.append(summary)
            elif excerpt:
                sections.append(_t(locale, "Key excerpt extracted from the file:", "我先提取出文件的关键片段："))
                sections.append(f"- {excerpt}")
            else:
                sections.append(_t(locale, "The file was read, but no extractable text is available yet.", "文件已读取，但暂时没有可提取的文本内容。"))
    sections.append(
        _t(
            locale,
            "After an available LLM service is configured, ask again and I can continue with a deeper answer using the full context.",
            "如果你配置好可用的 LLM 服务后再次提问，我会在完整上下文上继续给出更深入的回答。",
        )
    )
    return "\n\n".join(part for part in sections if part).strip()


# History loading.

_UI_BLOCK_RE = re.compile(
    r"```(?:helper-clarify|helper-form)[^`]*```",
    re.DOTALL,
)


def _strip_ui_blocks(text: str) -> str:
    """Remove helper-clarify and helper-form JSON code blocks before sending content to the LLM."""
    return _UI_BLOCK_RE.sub("", text).strip()


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


# Alias for history_pager.py compatibility
_get_names_for_messages = _resolve_display_names


async def _fetch_user_display_name(session, user_id: str) -> str:
    """Fetch one user display name and return an empty string on failure."""
    if not user_id:
        return ""
    from sqlalchemy import select

    from app.db.models import User

    r = await session.execute(select(User).where(User.user_id == user_id))
    u = r.scalar_one_or_none()
    return (u.display_name or u.username) if u else ""


async def _fetch_reply_context(session, replied_msg_id: str, locale: str | None = None) -> str:
    """Fetch a short prefix summarizing the message being replied to."""
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
        return _t(locale, f"Replying to [{sender_label}]: {quoted}\n\n", f"「回复 [{sender_label}]：{quoted}」\n\n")
    return _t(locale, f"Replying to: {quoted}\n\n", f"「回复：{quoted}」\n\n")


async def _fetch_chat_history(
    session,
    channel_id: str,
    before_msg_id: str | None,
    limit: int = HISTORY_MSG_COUNT,
    max_chars: int = HISTORY_MSG_MAX_CHARS,
) -> list:
    """Fetch chat messages before the trigger message and convert them into LangChain messages."""
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
        if len(content) > max_chars:
            content = content[:max_chars] + "…"
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
    enabled_tool_names: frozenset[str] | set[str] | None = None,
    locale: str | None = None,
):
    """Run the LangChain tool-calling agent loop and stream adapter events."""
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

    tools = _make_tools(ctx, enabled_tool_names)
    tool_map = {t.name: t for t in tools}
    llm_with_tools = llm.bind_tools(tools) if tools else llm

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
        logger.debug(
            "channel_bot[_run_agent]: enabled_tools=%s",
            sorted(tool_map.keys()),
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

            label = _tool_label(tool_name, tool_args if isinstance(tool_args, dict) else {}, locale)
            yield Delta(text=f"\n\n`🔧 {label}…`")

            t = tool_map.get(tool_name)
            if t is None:
                result_str = _t(locale, f"Error: unknown tool {tool_name}", f"错误：未知工具 {tool_name}")
            else:
                try:
                    result_str = str(await t.ainvoke(tool_args))
                except Exception as e:
                    logger.exception("channel_bot[tool]: %s failed: %s", tool_name, e)
                    result_str = _t(locale, f"Tool execution error: {e}", f"工具执行出错：{e}")

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
    """Built-in channel Bot adapter powered by a LangChain agent and channel tools."""

    async def execute(self, payload: AgentPayload):
        from app.features.bot_runtime.pipeline.adapter_events import Delta, Final

        user_text = payload.message.text
        all_attachments = payload.context.attachments or []
        pconfig = payload.runtime
        locale = normalize_locale(getattr(pconfig, "locale", None) or payload.message.extra.get("locale"))

        # Split image and document attachments.
        image_attachments = [a for a in all_attachments if a.get("is_image") == "true"]
        doc_attachments = [a for a in all_attachments if a.get("is_image") != "true"]

        # Document attachments only inject file references; agents call read_file on demand for body text.
        file_refs = _build_file_refs_note(doc_attachments, locale)
        if file_refs:
            user_text = (user_text.strip() + "\n\n" + file_refs) if user_text.strip() else file_refs

        channel_id = payload.channel_id
        channel_bots: list[str] = pconfig.channel_bot_usernames
        bot_details: dict = pconfig.channel_bot_details
        sender_id = payload.message.sender_id
        is_clarify_reply, clarify_answer_body = _strip_matching_prefix(user_text, _CLARIFY_PREFIXES)
        profile = (
            pconfig.coordinator_profile
            or build_coordinator_profile(
                user_text,
                has_attachments=bool(all_attachments),
                has_peer_bots=bool(channel_bots),
                is_clarify_reply=is_clarify_reply,
            )
        )
        memory = _trim_memory_for_profile(payload.context.memory or {}, profile)

        # 1. Build the system prompt.
        members_lines: list[str] = []
        if profile.include_bot_roster:
            for uname in channel_bots:
                detail = bot_details.get(uname) or {}
                display = detail.get("display_name") or uname
                desc = _clip_text(detail.get("description") or "", 180)
                caps: list[str] = []
                try:
                    intro = json.loads(detail.get("intro") or "{}")
                    caps = list(intro.get("capabilities") or [])[:5]
                except Exception:
                    pass
                line = f"- @{uname}（{display}）" if is_zh(locale) else f"- @{uname} ({display})"
                if desc:
                    line += f"：{desc}" if is_zh(locale) else f": {desc}"
                if caps:
                    line += _t(locale, f"  Capabilities: {', '.join(str(cap) for cap in caps)}", f"  能力：{'、'.join(str(cap) for cap in caps)}")
                members_lines.append(line)

        system_sections = [
            _t(
                locale,
                "You are AgentNexus's built-in intelligent collaboration assistant, responsible for usage guidance, project assistance, and coordination. Reply in English unless the user explicitly asks for another language.",
                "你是 AgentNexus 内置智能协作助手，兼顾使用引导、项目助手、协作协调三个职责。请默认使用中文回复，除非用户明确要求其他语言。",
            ),
            f"=== Context Policy ===\nintent={profile.intent}; tools={','.join(sorted(profile.enabled_tools)) or 'none'}",
        ]
        if profile.include_help:
            help_context = get_help_context_for_llm(user_text, limit=profile.help_limit, locale=locale)
            if help_context:
                system_sections.append(_t(locale, "=== System Help Context (filtered for the current question) ===\n", "=== 系统帮助文档（按当前问题筛选）===\n") + help_context)
        memory_xml = render_channel_memory_xml(memory)
        if memory_xml:
            system_sections.append(memory_xml)
        if payload.context.original_question_text:
            system_sections.append(
                _t(
                    locale,
                    f"=== Current Clarification Context ===\n[Original question]\n{payload.context.original_question_text}",
                    f"=== 当前澄清上下文 ===\n【原始问题】\n{payload.context.original_question_text}",
                )
            )
        if members_lines:
            system_sections.append(_t(locale, "=== Channel Bot Members (callable with call_bot) ===\n", "=== 频道 Bot 成员（可通过 call_bot 工具调用）===\n") + "\n".join(members_lines))
        system_sections.append(_build_behavior_rules(profile, locale))
        system_prompt = "\n\n".join(section for section in system_sections if section)

        # 2. Store clarification answers into decisions automatically.
        if is_clarify_reply and clarify_answer_body:
            from datetime import datetime, timezone

            from app.features.memory.manager import save_layer

            ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
            entry = f"### User clarification choice ({ts})\n{clarify_answer_body}"
            existing = ((payload.context.memory or {}).get("decisions") or "").rstrip()
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
            "locale": locale,
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
                    (
                        _fetch_chat_history(
                            db_session,
                            channel_id,
                            trigger_msg_id,
                            limit=profile.history_limit,
                            max_chars=profile.history_msg_max_chars,
                        )
                        if trigger_msg_id and profile.history_limit > 0
                        else _noop_list()
                    ),
                    _fetch_user_display_name(db_session, sender_id),
                    _fetch_reply_context(db_session, in_reply_to_msg_id, locale) if in_reply_to_msg_id else _noop_str(),
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

        # Clarification answers strip their prefix and skip reply_prefix.
        # The original question is already in the system prompt clarification context.
        if is_clarify_reply:
            user_text = clarify_answer_body
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
            img_ids_note = "\n\n" + _t(locale, "[System note] The user uploaded these image attachments:\n", "[系统提示] 用户本次上传了以下图片附件：\n") + "\n".join(
                _t(
                    locale,
                    f"- file_id: {a['file_id']}  filename: {a.get('filename') or a.get('file_id')}",
                    f"- file_id: {a['file_id']}  文件名: {a.get('filename') or a.get('file_id')}",
                )
                for a in image_attachments
                if a.get("file_id")
            )
            user_text = user_text + img_ids_note

        if supports_vision and any(a.get("image_b64") for a in image_attachments):
            user_content: str | list = _build_vision_content(user_text, image_attachments)
        else:
            if image_attachments:
                user_text += "\n\n" + _t(locale, "(Note: the current LLM does not have image recognition enabled, so image attachments were ignored.)", "（注：当前 LLM 未启用图片识别，已忽略图片附件。）")
            user_content = user_text

        # Stream Delta tokens directly out; capture the agent's final content.
        agent_final: Final | None = None
        async for event in _run_agent_iter(
            system_prompt,
            user_content,
            tool_ctx,
            history=chat_history,
            enabled_tool_names=profile.enabled_tools,
            locale=locale,
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
                _build_attachment_fallback_reply(user_text, payload.context.attachments, locale)
                or build_help_content_with_form(user_text, locale=locale)
                or _default_reply(locale)
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

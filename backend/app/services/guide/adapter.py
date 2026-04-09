"""引导 Bot 适配器：可选 LLM 或关键词匹配，根据帮助文档回复与动态表单."""
import json
import logging

from app.services.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.services.admin.settings_store import get_clarify_settings
from app.services.guide.help_index import (
    build_guide_content_with_form,
    get_form_for_intent,
    get_help_context_for_llm,
    get_rule_based_clarify_schema,
)
from app.services.guide.llm_client import chat as llm_chat
from app.services.guide.llm_client import generate_clarify_schema
from app.services.guide.llm_client import is_configured as llm_configured

logger = logging.getLogger("app.services.guide.adapter")

DEFAULT_REPLY = (
    "您可以说：怎么创建项目、怎么加入项目、怎么接入 OpenClaw、怎么发消息、"
    "左边没有项目、@ 没反应、怎么安装、报错排查 等，我会根据说明书为您引导。"
    "完整文档见 docs/使用说明书.md。"
)

SYSTEM_PROMPT_TEMPLATE = """你是 AgentNexus 系统的引导助手。请仅根据以下帮助文档回答用户问题，语气简洁友好。
可根据文档用自己的话概括或精简，不必逐字照抄；关键步骤、链接与文档保持一致，不要编造文档中没有的内容。
若用户问题与文档无关，可简要说明你能协助的范围并引导其提问。
回答请使用纯文本；若涉及《系统管理说明书》等，可用 Markdown 链接 [文字](url) 形式。

帮助文档：
---
{help_context}
---
"""


class GuideBotAdapter(OpenClawAdapter):
    """引导 Bot：优先用配置的 LLM 根据帮助文档生成回复；否则关键词匹配+动态表单."""

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        text = (payload.trigger_message or {}).get("text") or ""
        original_question = getattr(payload, "original_question_text", None) or ""
        help_ctx = get_help_context_for_llm()
        clarify_settings = get_clarify_settings()
        strict_mode = bool(clarify_settings.get("clarify_strict_mode", False))
        force_rule = bool(clarify_settings.get("clarify_force_rule", True))
        threshold = float(clarify_settings.get("clarify_threshold", 0.6))

        # 0) 澄清回答场景：合并原问题 + 澄清内容，直接生成最终回答，不再触发新一轮澄清
        is_clarify_reply = (
            text.strip().startswith("@引导 澄清回答：")
            or text.strip().startswith("@channel bot 澄清回答：")
            or "用户选择跳过澄清" in text
        )
        if is_clarify_reply:
            if not original_question:
                logger.warning(
                    "guide_bot: clarify reply but original_question empty, using full text as fallback"
                )
                original_question = "(原问题未找到，以下为用户澄清内容)"
            combined = (
                f"【原始问题】\n{original_question}\n\n"
                f"【用户补充澄清】\n{text}\n\n"
                "请基于以上原始问题与用户补充的澄清信息，给出完整、有针对性的回答。"
            )
            logger.info(
                "guide_bot: clarify merge prompt len=%s, original_len=%s",
                len(combined),
                len(original_question),
            )
            content = ""
            if llm_configured():
                system = SYSTEM_PROMPT_TEMPLATE.format(help_context=help_ctx)
                content = await llm_chat(system, combined)
            if not content:
                content = build_guide_content_with_form(combined)
            if not content:
                content = DEFAULT_REPLY
            logger.info("guide_bot: reply from clarify merge, len=%s", len(content or ""))
            return AgentResponse(
                content=content or DEFAULT_REPLY,
                task_id=payload.task_id,
                success=True,
            )

        # 1) 混合澄清触发：LLM 判断 + 规则兜底
        clarify = None
        llm_clarify = None
        rule_clarify = get_rule_based_clarify_schema(text)
        if llm_configured():
            llm_clarify = await generate_clarify_schema(text, help_ctx)

        if llm_clarify:
            score = llm_clarify.get("_score")
            if isinstance(score, (float, int)):
                if float(score) >= threshold:
                    clarify = llm_clarify
            else:
                # 无 score 时，沿用 need_clarify 布尔语义（返回了 schema 即视为 true）
                clarify = llm_clarify

        if strict_mode and llm_clarify and not clarify:
            # 严格模式下，LLM 已判定 need_clarify 但分数低于阈值时也允许触发
            clarify = llm_clarify

        if not clarify and force_rule and rule_clarify:
            clarify = rule_clarify

        if not clarify and not llm_clarify and rule_clarify:
            clarify = rule_clarify

        if clarify:
            clarify = {k: v for k, v in clarify.items() if k != "_score"}
            content = "为避免误解，我先确认几个问题。"
            content += "\n\n```guide-clarify\n" + json.dumps(clarify, ensure_ascii=False) + "\n```"
            logger.info("guide_bot: clarify popup generated, questions=%s", len(clarify.get("questions", [])))
            return AgentResponse(
                content=content,
                task_id=payload.task_id,
                success=True,
            )

        content = ""

        if llm_configured():
            system = SYSTEM_PROMPT_TEMPLATE.format(help_context=help_ctx)
            content = await llm_chat(system, text)

        if not content:
            content = build_guide_content_with_form(text)
            if content:
                logger.info(
                    "guide_bot: reply from keyword fallback (LLM not configured or request failed), user_msg=%s",
                    (text[:60] + "…") if len(text) > 60 else text,
                )
            else:
                content = DEFAULT_REPLY
                logger.info("guide_bot: reply = DEFAULT_REPLY (no LLM, no keyword match)")
        else:
            logger.info("guide_bot: reply from LLM, len=%s", len(content))
        if content:
            form = get_form_for_intent(text)
            if form:
                blob = json.dumps(form, ensure_ascii=False)
                content += "\n\n```guide-form\n" + blob + "\n```"

        return AgentResponse(
            content=content,
            task_id=payload.task_id,
            success=True,
        )

    async def health_check(self) -> bool:
        return True

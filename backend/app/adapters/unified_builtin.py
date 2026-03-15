"""统一内置 Bot 适配器：合并引导 / 助手 / 协调三合一。

功能：
- 引导：LLM 读帮助文档回答 + 关键词兜底 + 澄清弹窗（guide-clarify）+ 动态表单（guide-form）
- 助手：四层记忆注入 system prompt，回答项目业务问题
- 协调：可建议路由 @专业Bot；可读写四层记忆（memory-update 块）
"""
import json
import logging
import re

import httpx

from app.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.admin.settings_store import get_clarify_settings, get_provider_for_scope
from app.guide.help_index import (
    build_guide_content_with_form,
    get_form_for_intent,
    get_help_context_for_llm,
    get_rule_based_clarify_schema,
)
from app.guide.llm_client import (
    generate_clarify_schema,
    is_configured as guide_llm_configured,
)

logger = logging.getLogger("app.adapters.unified_builtin")

# 匹配 LLM 输出中的 ```memory-update ... ``` 块
_MEMORY_UPDATE_RE = re.compile(r"```memory-update\n([\s\S]*?)```")
_VALID_LAYERS = {"anchor", "decisions", "files_index", "recent"}
_LAYER_LABELS = {
    "anchor": "项目锚点",
    "decisions": "决策记录",
    "files_index": "资料索引",
    "recent": "近期动态",
}

_DEFAULT_REPLY = (
    "您可以说：怎么创建项目、怎么加入项目、怎么接入 OpenClaw、怎么发消息、"
    "左边没有项目、@ 没反应、怎么安装、报错排查 等，我会根据说明书为您引导。"
    "也可以直接问项目相关问题，我会结合频道上下文回答。"
)

_SYSTEM_PROMPT = """\
你是 AgentNexus 的内置智能助手，同时承担三个职责。

【职责一：系统使用引导】
根据以下帮助文档，解答系统使用类问题（如怎么创建项目、怎么接入 Bot 等）。
语气简洁友好，不要编造文档中没有的内容；关键步骤与链接请与文档保持一致。

帮助文档：
---
{help_context}
---

【职责二：项目助手】
结合以下四层项目记忆，回答业务与协作问题。
若记忆中没有相关信息，可结合通用知识回答并说明依据。
回答使用 Markdown 格式，语气专业友好。

=== 项目锚点（最高优先级）===
{anchor}

=== 重要决策记录 ===
{decisions}

=== 已上传资料索引 ===
{files_index}

=== 近期频道动态 ===
{recent}

【职责三：记忆管理与协调】
你可以自主判断是否需要更新记忆，无需等待用户明确要求。以下情况应主动写入：
- anchor：用户提到项目目标、核心约束或背景发生变化时
- decisions：对话中出现了明确的技术/业务决策时
- files_index：用户上传了文件或提到了新的资料/链接时
- recent：本次对话有重要进展、结论或待办事项时

需要写入时，在回复末尾附上 memory-update 块：
  ```memory-update
  {{"layer": "anchor", "content": "更新后的完整内容"}}
  ```
  layer 可选值：anchor / decisions / files_index / recent
  content 为该层的完整新内容（覆盖写入，请保留原有重要内容并追加新内容）。
  纯粹的问答、闲聊、系统引导类回复不需要写入。

- 若问题超出你的能力范围，而频道中有更合适的专业 Bot，
  可在回复末尾说「建议 @Bot名 回答 XXX 问题」（Bot 名必须来自下列列表）。
  当前频道可用的其他 Bot：{bots_hint}
"""


def _get_llm_config() -> dict | None:
    """优先 guide_bot，依次回退 assistant_bot / orchestrator / system_llm。"""
    for scope in ("guide_bot", "assistant_bot", "orchestrator", "system_llm"):
        cfg = get_provider_for_scope(scope)
        if cfg and cfg.get("base_url") and cfg.get("model"):
            return cfg
    return None


async def _call_llm(system: str, user_text: str) -> str | None:
    cfg = _get_llm_config()
    if not cfg:
        return None
    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    if cfg.get("api_key"):
        headers["Authorization"] = f"Bearer {cfg['api_key']}"
    extra = cfg.get("extra_headers")
    if isinstance(extra, dict):
        headers.update({str(k): str(v) for k, v in extra.items()})
    body = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_text},
        ],
        "temperature": float(cfg.get("temperature", 0.7)),
        "max_tokens": int(cfg.get("max_tokens", 1500)),
    }
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(url, json=body, headers=headers)
            r.raise_for_status()
            data = r.json()
            choice = (data.get("choices") or [{}])[0]
            return ((choice.get("message") or {}).get("content") or "").strip() or None
    except Exception as e:
        logger.exception("unified_builtin: LLM request failed: %s", e)
        return None


def _parse_memory_updates(content: str) -> list[dict]:
    """解析 LLM 回复中的 memory-update 块，返回 [{"layer": ..., "content": ...}, ...]。"""
    updates = []
    for m in _MEMORY_UPDATE_RE.finditer(content):
        try:
            obj = json.loads(m.group(1).strip())
            layer = obj.get("layer", "")
            new_content = obj.get("content", "")
            if layer in _VALID_LAYERS and isinstance(new_content, str):
                updates.append({"layer": layer, "content": new_content})
            else:
                logger.warning("unified_builtin: invalid memory-update block: %s", obj)
        except (json.JSONDecodeError, AttributeError) as e:
            logger.warning("unified_builtin: failed to parse memory-update block: %s", e)
    return updates


def _strip_memory_updates(content: str) -> str:
    """从 LLM 回复中移除 memory-update 块后返回（不向用户暴露原始块）。"""
    return _MEMORY_UPDATE_RE.sub("", content).strip()


class UnifiedBuiltinBotAdapter(OpenClawAdapter):
    """统一内置 Bot：引导 + 助手 + 记忆管理三合一。"""

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        user_text = (payload.trigger_message or {}).get("text") or ""
        memory = payload.memory_context or {}
        channel_id = payload.channel_id
        channel_bots = (payload.process_config or {}).get("channel_bot_usernames") or []

        # ── 1. 澄清弹窗（优先于 LLM 主回答） ────────────────────────────────
        clarify_settings = get_clarify_settings()
        strict_mode = bool(clarify_settings.get("clarify_strict_mode", False))
        force_rule = bool(clarify_settings.get("clarify_force_rule", True))
        threshold = float(clarify_settings.get("clarify_threshold", 0.6))

        clarify = None
        rule_clarify = get_rule_based_clarify_schema(user_text)

        if guide_llm_configured():
            help_ctx = get_help_context_for_llm()
            llm_clarify = await generate_clarify_schema(user_text, help_ctx)
            if llm_clarify:
                score = llm_clarify.get("_score")
                if isinstance(score, (float, int)):
                    if float(score) >= threshold or strict_mode:
                        clarify = llm_clarify
                else:
                    clarify = llm_clarify

        if not clarify and force_rule and rule_clarify:
            clarify = rule_clarify
        if not clarify and not guide_llm_configured() and rule_clarify:
            clarify = rule_clarify

        if clarify:
            clarify = {k: v for k, v in clarify.items() if k != "_score"}
            content = "为避免误解，我先确认几个问题。"
            content += "\n\n```guide-clarify\n" + json.dumps(clarify, ensure_ascii=False) + "\n```"
            logger.info(
                "unified_builtin: clarify popup, questions=%d channel=%s",
                len(clarify.get("questions", [])),
                channel_id,
            )
            return AgentResponse(content=content, task_id=payload.task_id, success=True)

        # ── 2. LLM 主回答（三层职责合一） ────────────────────────────────────
        bots_hint = "、".join("@" + b for b in channel_bots) if channel_bots else "（暂无其他专业 Bot）"
        system = _SYSTEM_PROMPT.format(
            help_context=get_help_context_for_llm(),
            anchor=memory.get("anchor") or "（暂无）",
            decisions=memory.get("decisions") or "（暂无）",
            files_index=memory.get("files_index") or "（暂无）",
            recent=memory.get("recent") or "（暂无）",
            bots_hint=bots_hint,
        )
        raw = await _call_llm(system, user_text)

        # ── 3. 解析并执行记忆写入 ─────────────────────────────────────────────
        content = ""
        if raw:
            updates = _parse_memory_updates(raw)
            content = _strip_memory_updates(raw)
            if updates:
                from app.memory.manager import save_layer
                written = []
                for upd in updates:
                    try:
                        await save_layer(channel_id, upd["layer"], upd["content"])
                        written.append(_LAYER_LABELS.get(upd["layer"], upd["layer"]))
                        logger.info(
                            "unified_builtin: memory updated layer=%s channel=%s len=%d",
                            upd["layer"], channel_id, len(upd["content"]),
                        )
                    except Exception as e:
                        logger.exception("unified_builtin: save_layer failed layer=%s: %s", upd["layer"], e)
                if written:
                    content += f"\n\n> 已更新记忆层：{'、'.join(written)}"

        # ── 4. 关键词兜底（LLM 不可用时） ────────────────────────────────────
        if not content:
            content = build_guide_content_with_form(user_text) or _DEFAULT_REPLY
            logger.info(
                "unified_builtin: LLM unavailable, keyword fallback channel=%s user_msg=%s",
                channel_id,
                (user_text[:60] + "…") if len(user_text) > 60 else user_text,
            )

        # ── 5. 附加动态表单（如有匹配意图） ──────────────────────────────────
        form = get_form_for_intent(user_text)
        if form:
            content += "\n\n```guide-form\n" + json.dumps(form, ensure_ascii=False) + "\n```"

        return AgentResponse(content=content, task_id=payload.task_id, success=True)

    async def health_check(self) -> bool:
        return _get_llm_config() is not None

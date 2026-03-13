"""频道 AI 助手适配器：将四层记忆注入 System Prompt，用 LLM 回答用户问题."""
import logging

import httpx

from app.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.admin.settings_store import get_provider_for_scope

logger = logging.getLogger("app.assistant.adapter")

_NOT_CONFIGURED_REPLY = (
    "当前 AI 助手未配置 LLM，请在「管理」→「LLM 设置」中绑定 guide_bot 或 assistant_bot。"
)

SYSTEM_PROMPT_TEMPLATE = """\
你是「{channel_id}」频道的 AI 助手，职责是结合项目上下文回答用户问题、协助协作。
请优先参考以下四层项目记忆来回答。若记忆中没有相关信息，可结合通用知识回答，并说明依据。
回答请简洁、使用 Markdown 格式，语气友好专业。

=== 项目锚点（核心目标与最高规则）===
{anchor}

=== 重要决策记录 ===
{decisions}

=== 已上传资料索引 ===
{files_index}

=== 近期频道动态 ===
{recent}
"""


def _get_llm_config() -> dict | None:
    """优先 assistant_bot scope，回退到 guide_bot。"""
    cfg = get_provider_for_scope("assistant_bot")
    if cfg and cfg.get("base_url") and cfg.get("model"):
        return cfg
    cfg = get_provider_for_scope("guide_bot")
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
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(url, json=body, headers=headers)
            r.raise_for_status()
            data = r.json()
            choice = (data.get("choices") or [{}])[0]
            content = (choice.get("message") or {}).get("content") or ""
            return content.strip() or None
    except Exception as e:
        logger.exception("assistant llm request failed: %s", e)
        return None


class AssistantBotAdapter(OpenClawAdapter):
    """内置频道 AI 助手：将四层记忆作为 System Prompt 注入，调用 LLM 回答用户问题。"""

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        user_text = (payload.trigger_message or {}).get("text") or ""
        memory = payload.memory_context or {}

        system = SYSTEM_PROMPT_TEMPLATE.format(
            channel_id=payload.channel_id,
            anchor=memory.get("anchor") or "（暂无）",
            decisions=memory.get("decisions") or "（暂无）",
            files_index=memory.get("files_index") or "（暂无）",
            recent=memory.get("recent") or "（暂无）",
        )

        content = await _call_llm(system, user_text)
        if not content:
            logger.warning("assistant: LLM not configured or request failed, channel_id=%s", payload.channel_id)
            content = _NOT_CONFIGURED_REPLY

        return AgentResponse(content=content, task_id=payload.task_id, success=True)

    async def health_check(self) -> bool:
        return _get_llm_config() is not None

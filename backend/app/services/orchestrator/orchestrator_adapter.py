"""Orchestrator 适配器：当用户未 @ 任何人且开启直接回答时，由 Orchestrator 回答业务问题并可选建议 @部门bot."""
import logging
import re

from app.services.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.services.admin.settings_store import get_provider_for_scope

logger = logging.getLogger("app.services.orchestrator.adapter")

# 匹配 "建议 @xxx" 或 "建议@xxx"
SUGGEST_PATTERN = re.compile(r"建议\s*@([a-zA-Z0-9_\u4e00-\u9fff]+)")


async def _call_llm(system: str, user_text: str) -> str:
    """调用 LLM 生成回复；无配置时返回兜底文案。"""
    cfg = get_provider_for_scope("orchestrator") or get_provider_for_scope("system_llm")
    if not cfg or not (cfg.get("base_url") and cfg.get("model")):
        return "当前未配置 Orchestrator 使用的 LLM，请在「管理」→「LLM 设置」中绑定 system_llm 或 orchestrator。"

    import httpx
    url = (cfg.get("base_url") or "").rstrip("/") + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    if cfg.get("api_key"):
        headers["Authorization"] = f"Bearer {cfg.get('api_key')}"
    payload = {
        "model": cfg.get("model", "gpt-4o-mini"),
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_text},
        ],
        "temperature": float(cfg.get("temperature", 0.5)),
        "max_tokens": int(cfg.get("max_tokens", 1500)),
    }
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(url, json=payload, headers=headers)
            r.raise_for_status()
            data = r.json()
            choice = (data.get("choices") or [{}])[0]
            msg = choice.get("message") or {}
            return (msg.get("content") or "").strip()
    except Exception as e:
        logger.exception("orchestrator llm request failed: %s", e)
        return f"Orchestrator 调用 LLM 失败：{e}"


class OrchestratorAdapter(OpenClawAdapter):
    """Orchestrator 直接回答模式：用 LLM 回答业务问题，可建议 @部门bot。"""

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        user_text = (payload.trigger_message or {}).get("text") or ""
        memory_context = payload.memory_context or {}
        channel_bots = (payload.process_config or {}).get("channel_bot_usernames") or []

        # 拼接上下文
        anchor = memory_context.get("anchor", "")
        decisions = memory_context.get("decisions", "")
        files_index = memory_context.get("files_index", "")
        recent = memory_context.get("recent", "")

        bots_hint = "当前频道可用的部门 Bot：" + ", ".join("@" + b for b in channel_bots) + "。" if channel_bots else "当前频道无其他部门 Bot。"
        system = """你是 AgentNexus 的 Orchestrator（业务问答 Bot）。用户的问题未 @ 任何 Bot，由你优先回答。

若问题属于系统使用（如怎么创建项目、怎么接入 OpenClaw），请简要说明并建议用户 @channel bot 获取详细指引。
若问题属于业务范畴，请根据上下文回答。{bots_hint}
若需要部门 Bot 的专业能力，可在回答末尾加上「建议 @Bot名 回答 XXX 问题」（Bot 名必须来自上述列表）。
回答请简洁，使用 Markdown 格式。

=== 项目锚点 ===
{anchor}

=== 重要决策 ===
{decisions}

=== 资料索引 ===
{files_index}

=== 近期动态 ===
{recent}
""".format(
            bots_hint=bots_hint,
            anchor=anchor or "（无）",
            decisions=decisions or "（无）",
            files_index=files_index or "（无）",
            recent=recent or "（无）",
        )

        content = await _call_llm(system, user_text)
        return AgentResponse(content=content, task_id=payload.task_id, success=True)

    async def health_check(self) -> bool:
        cfg = get_provider_for_scope("orchestrator") or get_provider_for_scope("system_llm")
        return bool(cfg and cfg.get("base_url") and cfg.get("model"))


def extract_suggested_bots(content: str) -> list[str]:
    """从 Orchestrator 回复中解析「建议 @xxx」的 Bot 名列表。"""
    return list(dict.fromkeys(SUGGEST_PATTERN.findall(content)))

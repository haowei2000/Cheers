"""通过 HTTP 调用 OpenClaw Gateway /hooks/agent 的适配器."""
import logging

import httpx

from app.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.config import settings

logger = logging.getLogger("app.adapters.http_openclaw")

HOOK_AGENT_PATH = "/hooks/agent"
TIMEOUT = 120.0


class HttpOpenClawAdapter(OpenClawAdapter):
    """将 AgentNexus 的 AgentPayload 转发到 OpenClaw /hooks/agent."""

    def __init__(self, base_url: str, timeout: float = TIMEOUT) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _hook_url(self) -> str:
        return f"{self.base_url}{HOOK_AGENT_PATH}"

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        text = payload.trigger_message.get("text", "")
        user_id = payload.trigger_message.get("user") or payload.trigger_message.get("sender_id") or "unknown"
        session_key = f"{settings.openclaw_session_prefix}{user_id}"

        hook_token = settings.openclaw_hook_token.strip()
        if not hook_token:
            logger.warning("http_openclaw: openclaw_hook_token 未配置，将不带认证头调用，可能被拒绝")

        body = {
            "message": text,
            "agentId": settings.openclaw_agent_id,
            "sessionKey": session_key,
            "wakeMode": "now",
            "deliver": False,
        }
        url = self._hook_url()
        headers = {
            "Content-Type": "application/json",
        }
        if hook_token:
            headers["Authorization"] = f"Bearer {hook_token}"

        logger.info("http_openclaw: POST %s sessionKey=%s", url, session_key)
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                r = await client.post(url, json=body, headers=headers)
                logger.info("http_openclaw: response status=%d", r.status_code)
                r.raise_for_status()
                # /hooks/agent 为异步接收，200 仅表示任务已接受
                return AgentResponse(
                    content="OpenClaw 已接收请求，正在处理…",
                    task_id=payload.task_id,
                    success=True,
                    error_message=None,
                )
        except httpx.HTTPError as e:
            logger.warning("http_openclaw: request failed url=%s error=%s", url, e)
            return AgentResponse(
                content="",
                task_id=payload.task_id,
                success=False,
                error_message=f"请求 OpenClaw 失败: {e!s}",
            )
        except Exception as e:
            logger.exception("http_openclaw: unexpected error url=%s", url)
            return AgentResponse(
                content="",
                task_id=payload.task_id,
                success=False,
                error_message=f"调用异常: {e!s}",
            )

    async def health_check(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(f"{self.base_url}/health")
                return r.status_code == 200
        except Exception:
            return False

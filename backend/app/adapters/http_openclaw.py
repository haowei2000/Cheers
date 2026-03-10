"""通过 HTTP 调用真实 OpenClaw 或兼容接口的适配器。"""
import logging

import httpx

from app.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter

logger = logging.getLogger("app.adapters.http_openclaw")

# 请求/响应约定：POST {openclaw_endpoint}/execute，body 为 Payload 的 JSON，响应 JSON 含 content、success、error_message
EXECUTE_PATH = "/execute"
TIMEOUT = 120.0


class HttpOpenClawAdapter(OpenClawAdapter):
    """向 openclaw_endpoint 发起 HTTP POST，发送 AgentPayload，解析为 AgentResponse。"""

    def __init__(self, base_url: str, timeout: float = TIMEOUT) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _execute_url(self) -> str:
        return f"{self.base_url}{EXECUTE_PATH}"

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        body = {
            "task_id": payload.task_id,
            "channel_id": payload.channel_id,
            "trigger_message": payload.trigger_message,
            "memory_context": payload.memory_context,
            "attachments": payload.attachments,
            "process_config": payload.process_config,
        }
        url = self._execute_url()
        logger.info("http_openclaw: POST %s", url)
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                r = await client.post(url, json=body)
                logger.info("http_openclaw: response status=%d", r.status_code)
                r.raise_for_status()
                data = r.json()
                content = data.get("content", "") or ""
                success = data.get("success", True)
                error_message = data.get("error_message")
                return AgentResponse(
                    content=content,
                    task_id=payload.task_id,
                    success=success,
                    error_message=error_message,
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

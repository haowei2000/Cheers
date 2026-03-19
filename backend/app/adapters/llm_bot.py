"""LLM Bot 适配器：将消息、记忆和上传文件解析结果一起发送给模型。"""
from __future__ import annotations

import json
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from app.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.db.models import AIModel, BotAccount, PromptTemplate

logger = logging.getLogger("app.adapters.llm_bot")

DEFAULT_TEMPERATURE = 0.7
DEFAULT_MAX_TOKENS = 2000


class LLMBotAdapter(OpenClawAdapter):
    """根据 Bot 的 model + template 配置调用 OpenAI-compatible LLM。"""

    def __init__(self, bot: BotAccount) -> None:
        self.bot = bot
        self.model: AIModel = bot.ai_model
        self.template: PromptTemplate = bot.prompt_template

    def _get_system_prompt(self) -> str:
        if self.bot.custom_system_prompt:
            return self.bot.custom_system_prompt
        return self.template.system_prompt

    def _apply_user_template(self, user_message: str, context: dict[str, Any] | None = None) -> str:
        template = self.template.user_template
        variables: dict[str, Any] = {"message": user_message}
        if context:
            variables.update(context)

        def replace_var(match: re.Match[str]) -> str:
            var_name = match.group(1)
            return str(variables.get(var_name, f"{{{{{var_name}}}}}"))

        return re.sub(r"\{\{(\w+)\}\}", replace_var, template)

    def _build_messages(self, user_message: str, context: dict[str, Any] | None = None) -> list[dict[str, str]]:
        return [
            {"role": "system", "content": self._get_system_prompt()},
            {"role": "user", "content": self._apply_user_template(user_message, context)},
        ]

    def _merge_attachments_into_message(self, user_message: str, attachments: list[dict[str, str]]) -> str:
        if not attachments:
            return user_message

        parts = [user_message.strip(), "", "以下是用户上传文件的解析结果，请优先基于这些内容回答："]
        for index, attachment in enumerate(attachments, start=1):
            parts.append(f"## 文件 {index}")
            parts.append(f"文件名: {attachment.get('filename') or attachment.get('file_id') or 'unknown'}")
            if attachment.get("content_type"):
                parts.append(f"类型: {attachment['content_type']}")
            if attachment.get("summary"):
                parts.append("摘要:")
                parts.append(attachment["summary"])
            parts.append("正文:")
            parts.append(attachment.get("content") or "")
            if attachment.get("truncated") == "true":
                parts.append("注意: 该文件文本已因长度限制被截断。")
            parts.append("")
        return "\n".join(parts).strip()

    def _get_api_config(self) -> dict[str, Any]:
        config: dict[str, Any] = {
            "provider": self.model.provider,
            "model_name": self.model.model_name,
            "base_url": self.model.base_url.rstrip("/"),
            "api_key": self.model.api_key,
        }
        if self.model.config:
            config.update(self.model.config)
        return config

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        user_text = (payload.trigger_message or {}).get("text", "")
        user_text = self._merge_attachments_into_message(user_text, payload.attachments or [])
        task_id = payload.task_id

        if not self.model or not self.template:
            return AgentResponse(
                content="",
                task_id=task_id,
                success=False,
                error_message="Bot 未配置模型或模板",
            )

        api_config = self._get_api_config()
        url = f"{api_config['base_url']}/chat/completions"

        headers = {"Content-Type": "application/json"}
        if api_config.get("api_key"):
            headers["Authorization"] = f"Bearer {api_config['api_key']}"
        extra_headers = api_config.get("extra_headers")
        if isinstance(extra_headers, dict):
            headers.update({str(key): str(value) for key, value in extra_headers.items()})

        context_vars: dict[str, str] = {}
        if payload.memory_context:
            context_vars = {
                "anchor": payload.memory_context.get("anchor", ""),
                "decisions": payload.memory_context.get("decisions", ""),
                "files_index": payload.memory_context.get("files_index", ""),
                "recent": payload.memory_context.get("recent", ""),
            }
        messages = self._build_messages(user_text, context_vars)

        body: dict[str, Any] = {
            "model": api_config["model_name"],
            "messages": messages,
            "temperature": api_config.get("temperature", DEFAULT_TEMPERATURE),
            "max_tokens": api_config.get("max_tokens", DEFAULT_MAX_TOKENS),
        }
        for key in ("top_p", "presence_penalty", "frequency_penalty"):
            if key in api_config:
                body[key] = api_config[key]

        logger.info(
            "llm_bot: bot=%s model=%s/%s task_id=%s attachments=%d",
            self.bot.username,
            api_config["provider"],
            api_config["model_name"],
            task_id,
            len(payload.attachments or []),
        )

        stream_token_cb: Callable[[str], Awaitable[None]] | None = (payload.process_config or {}).get("_stream_token")

        try:
            if stream_token_cb:
                body["stream"] = True
                full_content = ""
                async with httpx.AsyncClient(timeout=120.0) as client:
                    async with client.stream("POST", url, json=body, headers=headers) as response:
                        response.raise_for_status()
                        async for line in response.aiter_lines():
                            if not line.startswith("data: "):
                                continue
                            data_str = line[6:].strip()
                            if data_str == "[DONE]":
                                break
                            try:
                                chunk = json.loads(data_str)
                            except json.JSONDecodeError:
                                continue
                            delta = ((chunk.get("choices") or [{}])[0].get("delta") or {}).get("content") or ""
                            if not delta:
                                continue
                            full_content += delta
                            await stream_token_cb(delta)
                if not full_content:
                    return AgentResponse(
                        content="",
                        task_id=task_id,
                        success=False,
                        error_message="LLM 返回空内容",
                    )
                return AgentResponse(content=full_content.strip(), task_id=task_id, success=True)

            async with httpx.AsyncClient(timeout=120.0) as client:
                response = await client.post(url, json=body, headers=headers)
                response.raise_for_status()
                data = response.json()

            choices = data.get("choices", [])
            if not choices:
                return AgentResponse(
                    content="",
                    task_id=task_id,
                    success=False,
                    error_message="LLM 返回空响应 (no choices)",
                )

            content = (choices[0].get("message") or {}).get("content", "")
            if not content:
                return AgentResponse(
                    content="",
                    task_id=task_id,
                    success=False,
                    error_message="LLM 返回空内容",
                )
            return AgentResponse(content=content.strip(), task_id=task_id, success=True)

        except httpx.HTTPStatusError as exc:
            error_body = ""
            try:
                error_body = exc.response.text[:500]
            except Exception:
                pass
            logger.error(
                "llm_bot: HTTP error status=%s body=%s",
                exc.response.status_code,
                error_body,
            )
            return AgentResponse(
                content="",
                task_id=task_id,
                success=False,
                error_message=f"LLM API 错误 (HTTP {exc.response.status_code}): {error_body}",
            )
        except httpx.ConnectError as exc:
            logger.error("llm_bot: connection error %s", exc)
            return AgentResponse(
                content="",
                task_id=task_id,
                success=False,
                error_message=f"无法连接到 LLM API: {api_config['base_url']}",
            )
        except Exception as exc:
            logger.exception("llm_bot: unexpected error")
            return AgentResponse(
                content="",
                task_id=task_id,
                success=False,
                error_message=f"调用 LLM 时发生错误: {exc}",
            )

    async def health_check(self) -> bool:
        return bool(self.model and self.model.model_name and self.model.base_url)

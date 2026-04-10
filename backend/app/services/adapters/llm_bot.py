"""LLM Bot 适配器：将消息、记忆和上传文件解析结果一起发送给模型。"""
from __future__ import annotations

import json
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from app.db.models import AIModel, BotAccount, PromptTemplate
from app.http_client import get_http_client
from app.services.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.services.orchestrator.secrets import replace_secret_refs
from app.utils.crypto import decrypt_value

logger = logging.getLogger("app.services.adapters.llm_bot")

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

    def _has_image_attachments(self, attachments: list[dict[str, str]]) -> bool:
        return any(a.get("is_image") == "true" and a.get("image_b64") for a in attachments)

    def _build_vision_user_content(
        self, user_text: str, attachments: list[dict[str, str]],
    ) -> list[dict]:
        """构建 OpenAI Vision 格式的多模态 content 数组。"""
        parts: list[dict] = [{"type": "text", "text": user_text}]
        for att in attachments:
            if att.get("is_image") != "true":
                continue
            b64 = att.get("image_b64", "")
            if not b64:
                continue
            mime = att.get("content_type") or "image/jpeg"
            parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{b64}"},
            })
        return parts

    def _merge_attachments_into_message(self, user_message: str, attachments: list[dict[str, str]]) -> str:
        if not attachments:
            return user_message

        file_parts = []
        for attachment in attachments:
            filename = attachment.get("filename") or attachment.get("file_id") or "unknown"
            attrs = f'filename="{filename}"'
            if attachment.get("content_type"):
                attrs += f' type="{attachment["content_type"]}"'
            if attachment.get("file_id"):
                attrs += f' file_id="{attachment["file_id"]}"'
            lines = [f"  <file {attrs}>"]
            if attachment.get("summary"):
                lines.append(f"    <summary>{attachment['summary']}</summary>")
            content = attachment.get("content") or ""
            lines.append(f"    <content>{content}</content>")
            if attachment.get("truncated") == "true":
                lines.append("    <truncated>true</truncated>")
            lines.append("  </file>")
            file_parts.append("\n".join(lines))

        attachments_block = "<attachments>\n" + "\n".join(file_parts) + "\n</attachments>"
        return user_message.strip() + "\n\n" + attachments_block

    def _get_api_config(self) -> dict[str, Any]:
        config: dict[str, Any] = {
            "provider": self.model.provider,
            "model_name": self.model.model_name,
            "base_url": self.model.base_url.rstrip("/"),
            "api_key": decrypt_value(self.model.api_key or "") or None,
        }
        if self.model.config:
            config.update(self.model.config)
        return config

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        """执行 LLM 调用。

        上下文注入机制：
        - payload.memory_context 包含四层记忆：anchor, decisions, files_index, recent
        - 这些记忆会被注入为模板变量 {{anchor}}, {{decisions}}, {{files_index}}, {{recent}}
        - 可以在 PromptTemplate 的 user_template 中使用这些变量来访问项目上下文
        - 例如："请基于以下项目锚点回答：{{anchor}}\n\n用户问题：{{message}}"
        """
        user_text = (payload.trigger_message or {}).get("text", "")
        task_id = payload.task_id
        all_attachments = payload.attachments or []

        # 解密：将 $secret{name} 引用替换为实际密钥值，
        # 并将加密消息占位符替换为解密后的原文
        user_secrets = (payload.process_config or {}).get("_user_secrets") or {}
        if user_secrets:
            encrypted_msg = user_secrets.get("_encrypted_msg")
            if encrypted_msg and "🔒" in user_text:
                user_text = user_text.replace("🔒 [加密消息]", encrypted_msg)
            user_text = replace_secret_refs(user_text, user_secrets)

        # 分离图片与文档附件
        image_attachments = [a for a in all_attachments if a.get("is_image") == "true"]
        doc_attachments = [a for a in all_attachments if a.get("is_image") != "true"]

        # 文档附件合并到文本
        user_text = self._merge_attachments_into_message(user_text, doc_attachments)

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

        pconfig = payload.process_config or {}
        trigger_meta = payload.trigger_message or {}

        context_vars: dict[str, str] = {
            "sender_name": pconfig.get("_sender_name") or trigger_meta.get("user", ""),
            "channel_name": pconfig.get("_channel_name") or "",
            "channel_id": payload.channel_id,
            "bot_name": self.bot.display_name or self.bot.username,
            "timestamp": trigger_meta.get("timestamp", ""),
        }
        if payload.memory_context:
            context_vars.update({
                "anchor": f"<anchor>{payload.memory_context.get('anchor', '')}</anchor>",
                "decisions": f"<decisions>{payload.memory_context.get('decisions', '')}</decisions>",
                "files_index": f"<files_index>{payload.memory_context.get('files_index', '')}</files_index>",
                "recent": f"<recent>{payload.memory_context.get('recent', '')}</recent>",
                "todos": payload.memory_context.get("todos", ""),
            })

        # Vision 路径：模型支持且有图片时，构建多模态消息
        supports_vision = (self.model.config or {}).get("supports_vision", True)
        if supports_vision and self._has_image_attachments(all_attachments):
            templated_text = self._apply_user_template(user_text, context_vars)
            vision_content = self._build_vision_user_content(templated_text, all_attachments)
            messages = [
                {"role": "system", "content": self._get_system_prompt()},
                {"role": "user", "content": vision_content},
            ]
        else:
            if image_attachments:
                user_text += "\n\n（注：该 Bot 未启用图片识别，已忽略图片附件。如需识别图片，请在模型配置中开启 supports_vision。）"
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

        # 重要：如果模型配置中有 stream=true，必须忽略它，由代码根据 stream_token_cb 决定是否流式
        # 否则 LLM 会返回流式响应，导致非流式处理的 response.json() 挂起
        if api_config.get("stream"):
            logger.warning("llm_bot: model config has stream=true, ignoring it")

        logger.info(
            "llm_bot: bot=%s model=%s/%s task_id=%s attachments=%d",
            self.bot.username,
            api_config["provider"],
            api_config["model_name"],
            task_id,
            len(payload.attachments or []),
        )

        stream_token_cb: Callable[[str], Awaitable[None]] | None = (payload.process_config or {}).get("_stream_token")
        timeout = float(api_config.get("timeout", 600))

        try:
            client = get_http_client()
            if stream_token_cb:
                body["stream"] = True
                full_content = ""
                async with client.stream("POST", url, json=body, headers=headers, timeout=timeout) as response:
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

            response = await client.post(url, json=body, headers=headers, timeout=timeout)
            response.raise_for_status()

            # 检测：如果响应是流式 (text/event-stream)，即使没设置 stream=true 也要按流式处理
            content_type = response.headers.get("content-type", "")
            if "text/event-stream" in content_type:
                logger.warning("llm_bot: received streaming response unexpectedly, draining stream")
                full_content = ""
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
                    full_content += delta
                if not full_content:
                    return AgentResponse(
                        content="",
                        task_id=task_id,
                        success=False,
                        error_message="LLM 返回空内容",
                    )
                return AgentResponse(content=full_content.strip(), task_id=task_id, success=True)

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

        except httpx.TimeoutException as exc:
            logger.warning(
                "llm_bot: timeout after %.0fs bot=%s: %s",
                timeout, self.bot.username, type(exc).__name__,
            )
            return AgentResponse(
                content="",
                task_id=task_id,
                success=False,
                error_message=f"LLM 响应超时（>{timeout:.0f}s），请检查模型服务或在模型配置中增大 timeout 值",
            )
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
        except httpx.RemoteProtocolError as exc:
            logger.error("llm_bot: server disconnected without response %s", exc)
            return AgentResponse(
                content="",
                task_id=task_id,
                success=False,
                error_message=f"LLM 服务断开连接（未返回响应），请检查模型服务是否正常: {api_config['base_url']}",
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

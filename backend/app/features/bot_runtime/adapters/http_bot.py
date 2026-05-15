"""HTTP Bot 适配器：将消息、记忆和上传文件解析结果一起发送给模型。"""
from __future__ import annotations

import json
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.core.log_context import bind_context
from app.db.models import AIModel, BotAccount, PromptTemplate
from app.features.bot_runtime.adapters.base import AgentPayload, BotAdapter
from app.features.bot_runtime.adapters.prompt_template import (
    build_template_context,
    render_user_template,
)
from app.features.bot_runtime.pipeline.adapter_events import AdapterEvent, Delta, Final
from app.features.bot_runtime.pipeline.bot.secrets import replace_secret_refs
from app.http_client import get_http_client
from app.services.secret_messages import replace_secret_placeholder
from app.utils.crypto import decrypt_value

logger = logging.getLogger("app.features.bot_runtime.adapters.http_bot")

DEFAULT_TEMPERATURE = 0.7
DEFAULT_MAX_TOKENS = 2000


class HttpBotAdapter(BotAdapter):
    """根据 Bot 的 model + template 配置调用 OpenAI-compatible LLM。"""

    def __init__(
        self,
        bot: BotAccount,
        *,
        model_override: AIModel | None = None,
        template_override: PromptTemplate | None = None,
    ) -> None:
        self.bot = bot
        model = model_override or bot.ai_model
        template = template_override or bot.prompt_template
        if model is None or template is None:
            raise ValueError("HTTP bot requires both AIModel and PromptTemplate")
        self.model: AIModel = model
        self.template: PromptTemplate = template

    def _get_system_prompt(self) -> str:
        base = self.bot.custom_system_prompt or self.template.system_prompt
        bot_name = self.bot.display_name or self.bot.username
        return f"你在当前频道中的名称是「{bot_name}」。\n\n{base}"

    def _apply_user_template(self, user_message: str, context: dict[str, Any] | None = None) -> str:
        return render_user_template(
            self.template.user_template,
            message=user_message,
            context=context,
        )

    def _build_messages(
        self,
        user_message: str,
        context: dict[str, Any] | None = None,
    ) -> list[dict[str, str]]:
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
            if attachment.get("preview_url"):
                lines.append(f"    <preview_url>{attachment['preview_url']}</preview_url>")
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

    def _format_topic_messages(self, messages: list[dict]) -> str:
        lines = []
        for m in messages:
            ts = (m.get("timestamp") or "")[:19].replace("T", " ")
            name = m.get("sender_name") or "unknown"
            text = (m.get("text") or "").strip()
            lines.append(f"[{ts}] {name}: {text}")
        return "\n".join(lines)

    def _apply_topic_context(self, trigger_meta: dict, user_text: str) -> str:
        """根据消息类型（msg_type）注入主题上下文。"""
        topic_chain: list[dict] = trigger_meta.get("topic_chain") or []
        child_replies: list[dict] = trigger_meta.get("child_replies") or []
        msg_type = trigger_meta.get("msg_type") or (
            "reply" if trigger_meta.get("in_reply_to_msg_id") else "normal"
        )

        if msg_type == "reply" and topic_chain:
            # 规则2/3：回复消息，携带祖先链
            return (
                "--- 主题上下文（从旧到新）---\n"
                + self._format_topic_messages(topic_chain)
                + "\n--- 当前用户消息 ---\n"
                + user_text
            )
        if msg_type == "topic" and child_replies:
            # 规则4：主题根，携带已有子回复
            return (
                "--- 此主题的已有回复 ---\n"
                + self._format_topic_messages(child_replies)
                + "\n--- 当前用户消息 ---\n"
                + user_text
            )
        # 规则1：普通消息，直接传原始内容
        return user_text

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

    def _build_headers(self, api_config: dict[str, Any]) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if api_config.get("api_key"):
            headers["Authorization"] = f"Bearer {api_config['api_key']}"
        extra_headers = api_config.get("extra_headers")
        if isinstance(extra_headers, dict):
            headers.update({str(key): str(value) for key, value in extra_headers.items()})
        return headers

    @staticmethod
    def _ollama_root_url(base_url: str) -> str | None:
        base = (base_url or "").strip().rstrip("/")
        if not base or "11434" not in base:
            return None
        if base.endswith("/v1"):
            return base[:-3].rstrip("/")
        return base

    @staticmethod
    def _model_name_matches(configured: str, available: str) -> bool:
        configured = (configured or "").strip()
        available = (available or "").strip()
        if not configured or not available:
            return False
        return available == configured or (":" not in configured and available.startswith(f"{configured}:"))

    @staticmethod
    def _extract_model_names(data: Any) -> list[str]:
        if not isinstance(data, dict):
            return []
        names: list[str] = []
        for key in ("data", "models"):
            items = data.get(key)
            if not isinstance(items, list):
                continue
            for item in items:
                if isinstance(item, str):
                    names.append(item)
                    continue
                if not isinstance(item, dict):
                    continue
                for field in ("id", "name", "model"):
                    value = item.get(field)
                    if isinstance(value, str) and value:
                        names.append(value)
        return names

    async def _probe_models_endpoint(
        self,
        client: httpx.AsyncClient,
        api_config: dict[str, Any],
        headers: dict[str, str],
    ) -> bool | None:
        """Return None when the service does not expose a usable model-list endpoint."""
        base_url = api_config["base_url"]
        probe_urls: list[str] = []
        if (api_config.get("provider") or "").lower() == "ollama":
            ollama_root = self._ollama_root_url(base_url)
            if ollama_root:
                probe_urls.append(f"{ollama_root}/api/tags")
        probe_urls.append(f"{base_url}/models")

        seen: set[str] = set()
        for url in probe_urls:
            if url in seen:
                continue
            seen.add(url)
            try:
                response = await client.get(url, headers=headers)
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout):
                raise
            except Exception:
                continue
            if response.status_code == 503:
                # Busy but reachable: treat the backing service as online.
                return True
            if response.status_code in (404, 405):
                continue
            response.raise_for_status()
            try:
                data = response.json()
            except ValueError:
                return True
            model_names = self._extract_model_names(data)
            if not model_names:
                return True
            configured_model = api_config["model_name"]
            return any(self._model_name_matches(configured_model, name) for name in model_names)
        return None

    async def _probe_chat_completion(
        self,
        client: httpx.AsyncClient,
        api_config: dict[str, Any],
        headers: dict[str, str],
    ) -> bool:
        url = f"{api_config['base_url']}/chat/completions"
        body = {
            "model": api_config["model_name"],
            "messages": [{"role": "user", "content": "ping"}],
            "temperature": 0,
            "max_tokens": 1,
            "stream": False,
        }
        response = await client.post(url, json=body, headers=headers)
        if response.status_code == 503:
            return True
        response.raise_for_status()
        data = response.json()
        return bool(data.get("choices"))

    async def execute(self, payload: AgentPayload) -> AsyncIterator[AdapterEvent]:
        """执行 LLM 调用，流式 yield ``Delta`` per token + 最终 ``Final``.

        上下文注入机制：
        - payload.context.memory 由 ContextLoadStage 在模板包含 {{memory}}
          时加载并渲染为模板变量
        - 是否发送记忆完全由 PromptTemplate.user_template 决定
        """
        with bind_context(bot_id=self.bot.bot_id):
            async for event in self._execute_inner(payload):
                yield event

    async def _execute_inner(self, payload: AgentPayload) -> AsyncIterator[AdapterEvent]:
        user_text = payload.message.text
        task_id = payload.task_id
        all_attachments = payload.context.attachments or []
        pconfig = payload.runtime
        delegated_task_xml = bool(pconfig.delegated_task_xml)

        # 解密：将 $secret{name} 引用替换为实际密钥值，
        # 并将加密消息占位符替换为解密后的原文
        user_secrets = payload.runtime.user_secrets
        if user_secrets:
            encrypted_msg = user_secrets.get("_encrypted_msg")
            if encrypted_msg and "🔒" in user_text:
                user_text = replace_secret_placeholder(user_text, encrypted_msg)
            user_text = replace_secret_refs(user_text, user_secrets)

        # 分离图片与文档附件
        image_attachments = [a for a in all_attachments if a.get("is_image") == "true"]
        doc_attachments = [a for a in all_attachments if a.get("is_image") != "true"]

        # 文档附件合并到文本。call_bot 的 XML 委托提示已包含附件索引，
        # 这里不再把 <attachments> 追加到 XML 根节点外。
        if not delegated_task_xml:
            user_text = self._merge_attachments_into_message(user_text, doc_attachments)

        # 注入主题上下文（4条规则）
        trigger_meta = payload.trigger_message or {}
        if not delegated_task_xml:
            user_text = self._apply_topic_context(trigger_meta, user_text)

        if not self.model or not self.template:
            yield Final(content="", success=False, error_message="Bot 未配置模型或模板")
            return

        api_config = self._get_api_config()
        url = f"{api_config['base_url']}/chat/completions"

        headers = self._build_headers(api_config)

        trigger_meta = payload.trigger_message or {}

        context_vars = build_template_context(
            bot_name=self.bot.display_name or self.bot.username,
            channel_id=payload.channel_id,
            channel_name=pconfig.channel_name,
            sender_name=trigger_meta.get("sender_name") or pconfig.sender_name,
            timestamp=trigger_meta.get("timestamp", ""),
            memory_context=payload.context.memory,
        )

        # 子 bot 调用（call_bot）时跳过 system prompt，父 bot 的 message 已包含任务描述
        skip_system_prompt = pconfig.skip_system_prompt

        # Vision 路径：模型支持且有图片时，构建多模态消息
        supports_vision = (self.model.config or {}).get("supports_vision", True)
        if delegated_task_xml:
            # XML delegation is a complete prompt document. Do not wrap it in
            # PromptTemplate.user_template, otherwise memory/message get mixed
            # back into the old free-form shape.
            if supports_vision and self._has_image_attachments(all_attachments):
                vision_content = self._build_vision_user_content(user_text.strip(), all_attachments)
                messages = [{"role": "user", "content": vision_content}]
            else:
                messages = [{"role": "user", "content": user_text.strip()}]
        elif supports_vision and self._has_image_attachments(all_attachments):
            templated_text = self._apply_user_template(user_text, context_vars)
            vision_content = self._build_vision_user_content(templated_text, all_attachments)
            messages = [{"role": "user", "content": vision_content}]
            if not skip_system_prompt:
                messages.insert(0, {"role": "system", "content": self._get_system_prompt()})
        else:
            if image_attachments:
                user_text += "\n\n（注：该 Bot 未启用图片识别，已忽略图片附件。如需识别图片，请在模型配置中开启 supports_vision。）"
            if skip_system_prompt:
                messages = [{"role": "user", "content": self._apply_user_template(user_text, context_vars)}]
            else:
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
            logger.warning("http_bot: model config has stream=true, ignoring it")

        logger.info(
            "http_bot: bot=%s model=%s/%s task_id=%s attachments=%d",
            self.bot.username,
            api_config["provider"],
            api_config["model_name"],
            task_id,
            len(payload.context.attachments or []),
        )
        if logger.isEnabledFor(logging.DEBUG):
            for idx, msg in enumerate(messages):
                role = msg.get("role", "?")
                content = msg.get("content", "")
                # 多模态消息的 content 可能是列表，只摘要显示
                if isinstance(content, list):
                    parts_summary = ", ".join(
                        p.get("type", "?") for p in content if isinstance(p, dict)
                    )
                    logger.debug(
                        "http_bot: messages[%d] role=%s content=[%s] (%d parts)",
                        idx, role, parts_summary, len(content),
                    )
                else:
                    logger.debug(
                        "http_bot: messages[%d] role=%s content(%d chars):\n%s",
                        idx, role, len(content), content,
                    )

        body["stream"] = True
        timeout = float(api_config.get("timeout", 600))
        t0 = time.perf_counter()

        try:
            client = get_http_client()
            full_content = ""
            async with client.stream("POST", url, json=body, headers=headers, timeout=timeout) as response:
                response.raise_for_status()
                content_type = response.headers.get("content-type", "")
                if "text/event-stream" not in content_type:
                    # Server ignored stream=true; collect the JSON body and emit
                    # a single Final without per-token Delta events.
                    raw = await response.aread()
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        yield Final(content="", success=False, error_message="LLM 返回非 JSON 响应")
                        return
                    choices = data.get("choices", [])
                    if not choices:
                        yield Final(content="", success=False, error_message="LLM 返回空响应 (no choices)")
                        return
                    content = (choices[0].get("message") or {}).get("content", "")
                    dur_ms = (time.perf_counter() - t0) * 1000
                    if not content:
                        logger.warning("http_bot: empty response bot=%s duration_ms=%.0f", self.bot.username, dur_ms)
                        yield Final(content="", success=False, error_message="LLM 返回空内容")
                        return
                    token_count = (data.get("usage") or {}).get("total_tokens")
                    logger.info(
                        "http_bot: complete bot=%s model=%s duration_ms=%.0f tokens=%s",
                        self.bot.username, api_config["model_name"], dur_ms, token_count,
                    )
                    yield Final(content=content.strip(), success=True)
                    return

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
                    yield Delta(text=delta)
            dur_ms = (time.perf_counter() - t0) * 1000
            if not full_content:
                logger.warning("http_bot: empty stream response bot=%s duration_ms=%.0f", self.bot.username, dur_ms)
                yield Final(content="", success=False, error_message="LLM 返回空内容")
                return
            logger.info(
                "http_bot: stream complete bot=%s model=%s duration_ms=%.0f",
                self.bot.username, api_config["model_name"], dur_ms,
            )
            yield Final(content=full_content.strip(), success=True)
            return

        except httpx.TimeoutException as exc:
            dur_ms = (time.perf_counter() - t0) * 1000
            logger.warning(
                "http_bot: timeout after %.0fs bot=%s: %s duration_ms=%.0f",
                timeout, self.bot.username, type(exc).__name__, dur_ms,
            )
            yield Final(
                content="", success=False,
                error_message=f"LLM 响应超时（>{timeout:.0f}s），请检查模型服务或在模型配置中增大 timeout 值",
            )
            return
        except httpx.HTTPStatusError as exc:
            dur_ms = (time.perf_counter() - t0) * 1000
            error_body = ""
            try:
                error_body = exc.response.text[:500]
            except Exception:
                pass
            logger.error(
                "http_bot: HTTP error status=%s body=%s duration_ms=%.0f",
                exc.response.status_code, error_body, dur_ms,
            )
            yield Final(
                content="", success=False,
                error_message=f"LLM API 错误 (HTTP {exc.response.status_code}): {error_body}",
            )
            return
        except httpx.ConnectError as exc:
            dur_ms = (time.perf_counter() - t0) * 1000
            logger.error("http_bot: connection error %s duration_ms=%.0f", exc, dur_ms)
            yield Final(
                content="", success=False,
                error_message=f"无法连接到 LLM API: {api_config['base_url']}",
            )
            return
        except httpx.RemoteProtocolError as exc:
            logger.error("http_bot: server disconnected without response %s", exc)
            yield Final(
                content="", success=False,
                error_message=f"LLM 服务断开连接（未返回响应），请检查模型服务是否正常: {api_config['base_url']}",
            )
            return
        except Exception as exc:
            dur_ms = (time.perf_counter() - t0) * 1000
            logger.exception("http_bot: unexpected error duration_ms=%.0f", dur_ms)
            yield Final(content="", success=False, error_message=f"调用 LLM 时发生错误: {exc}")
            return

    async def health_check(self) -> bool:
        if not (self.model and self.model.model_name and self.model.base_url):
            return False

        api_config = self._get_api_config()
        timeout = float(api_config.get("health_timeout", min(float(api_config.get("timeout", 15)), 15)))
        headers = self._build_headers(api_config)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                models_probe = await self._probe_models_endpoint(client, api_config, headers)
                if models_probe is not None:
                    return models_probe
                return await self._probe_chat_completion(client, api_config, headers)
        except Exception as exc:
            logger.info(
                "http_bot.health_check.failed bot_id=%s model=%s base_url=%s error=%s",
                self.bot.bot_id,
                api_config.get("model_name"),
                api_config.get("base_url"),
                exc,
            )
            return False

"""LLM Bot 适配器：根据 Bot 配置的模型和模板直接调用 LLM API.

架构：Bot = AIModel + PromptTemplate
- AIModel 提供模型参数（provider, model_name, base_url, api_key）
- PromptTemplate 提供提示词（system_prompt, user_template）
"""
import json
import logging
import re
from typing import Any, Callable, Awaitable

import httpx

from app.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.db.models import AIModel, BotAccount, PromptTemplate

logger = logging.getLogger("app.adapters.llm_bot")

DEFAULT_TEMPERATURE = 0.7
DEFAULT_MAX_TOKENS = 2000


class LLMBotAdapter(OpenClawAdapter):
    """内置 LLM Bot 适配器：根据 Bot 的 model + template 配置调用 LLM.
    
    Args:
        bot: BotAccount 实例（包含关联的 ai_model 和 prompt_template）
    """

    def __init__(self, bot: BotAccount) -> None:
        self.bot = bot
        self.model: AIModel = bot.ai_model
        self.template: PromptTemplate = bot.prompt_template

    def _get_system_prompt(self) -> str:
        """获取系统提示词（优先使用自定义的）."""
        if self.bot.custom_system_prompt:
            return self.bot.custom_system_prompt
        return self.template.system_prompt

    def _apply_user_template(self, user_message: str, context: dict | None = None) -> str:
        """应用用户消息模板.
        
        支持 {{message}} 占位符，以及模板中定义的其他变量。
        """
        template = self.template.user_template
        
        # 构建变量映射
        variables = {"message": user_message}
        if context:
            variables.update(context)
        
        # 替换所有 {{variable}} 格式的占位符
        def replace_var(match: re.Match) -> str:
            var_name = match.group(1)
            return str(variables.get(var_name, f"{{{{{var_name}}}}}"))
        
        result = re.sub(r'\{\{(\w+)\}\}', replace_var, template)
        return result

    def _build_messages(self, user_message: str, context: dict | None = None) -> list[dict[str, str]]:
        """构建消息列表（System + User）."""
        system_prompt = self._get_system_prompt()
        formatted_user_msg = self._apply_user_template(user_message, context)
        
        return [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": formatted_user_msg},
        ]

    def _get_api_config(self) -> dict[str, Any]:
        """获取 API 配置."""
        config = {
            "provider": self.model.provider,
            "model_name": self.model.model_name,
            "base_url": self.model.base_url.rstrip("/"),
            "api_key": self.model.api_key,
        }
        
        # 合并模型配置
        if self.model.config:
            config.update(self.model.config)
        
        return config

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        """调用 LLM API 获取响应."""
        user_text = (payload.trigger_message or {}).get("text", "")
        task_id = payload.task_id
        
        if not self.model or not self.template:
            return AgentResponse(
                content="",
                task_id=task_id,
                success=False,
                error_message="Bot 未配置模型或模板",
            )

        # 构建请求
        api_config = self._get_api_config()
        url = f"{api_config['base_url']}/chat/completions"
        
        headers = {"Content-Type": "application/json"}
        if api_config.get("api_key"):
            headers["Authorization"] = f"Bearer {api_config['api_key']}"
        extra = api_config.get("extra_headers")
        if isinstance(extra, dict):
            headers.update({str(k): str(v) for k, v in extra.items()})

        # 构建消息
        # 从 memory_context 中提取可能的上下文变量
        context_vars = {}
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

        # 添加额外配置
        for key in ["top_p", "presence_penalty", "frequency_penalty"]:
            if key in api_config:
                body[key] = api_config[key]

        logger.info(
            "llm_bot: bot=%s model=%s/%s task_id=%s",
            self.bot.username,
            api_config["provider"],
            api_config["model_name"],
            task_id,
        )

        stream_token_cb: Callable[[str], Awaitable[None]] | None = (
            (payload.process_config or {}).get("_stream_token")
        )

        try:
            if stream_token_cb:
                body["stream"] = True
                full_content = ""
                async with httpx.AsyncClient(timeout=120.0) as client:
                    async with client.stream("POST", url, json=body, headers=headers) as r:
                        r.raise_for_status()
                        async for line in r.aiter_lines():
                            if not line.startswith("data: "):
                                continue
                            data_str = line[6:].strip()
                            if data_str == "[DONE]":
                                break
                            try:
                                chunk = json.loads(data_str)
                                delta = ((chunk.get("choices") or [{}])[0].get("delta") or {}).get("content") or ""
                                if delta:
                                    full_content += delta
                                    await stream_token_cb(delta)
                            except (json.JSONDecodeError, KeyError):
                                pass
                if not full_content:
                    return AgentResponse(content="", task_id=task_id, success=False, error_message="LLM 返回空内容")
                logger.info("llm_bot: stream success bot=%s content_len=%d", self.bot.username, len(full_content))
                return AgentResponse(content=full_content.strip(), task_id=task_id, success=True)

            async with httpx.AsyncClient(timeout=120.0) as client:
                r = await client.post(url, json=body, headers=headers)
                r.raise_for_status()
                data = r.json()

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

                logger.info(
                    "llm_bot: success bot=%s content_len=%d",
                    self.bot.username,
                    len(content),
                )
                return AgentResponse(
                    content=content.strip(),
                    task_id=task_id,
                    success=True,
                )

        except httpx.HTTPStatusError as e:
            error_body = ""
            try:
                error_body = e.response.text[:500]
            except Exception:
                pass
            logger.error(
                "llm_bot: HTTP error status=%s body=%s",
                e.response.status_code,
                error_body,
            )
            return AgentResponse(
                content="",
                task_id=task_id,
                success=False,
                error_message=f"LLM API 错误 (HTTP {e.response.status_code}): {error_body}",
            )

        except httpx.ConnectError as e:
            logger.error("llm_bot: connection error %s", e)
            return AgentResponse(
                content="",
                task_id=task_id,
                success=False,
                error_message=f"无法连接到 LLM API: {api_config['base_url']}",
            )

        except Exception as e:
            logger.exception("llm_bot: unexpected error")
            return AgentResponse(
                content="",
                task_id=task_id,
                success=False,
                error_message=f"调用 LLM 时发生错误: {e!s}",
            )

    async def health_check(self) -> bool:
        """检查 LLM API 是否可用."""
        if not self.model:
            return False
        # 简单检查配置是否完整
        return bool(self.model.model_name and self.model.base_url)

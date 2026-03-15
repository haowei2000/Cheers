"""统一内置 Bot 适配器：Agent Loop + 工具集。

工具：
  call_bot        — @某Bot，将子任务委托给频道内专业 Bot
  update_anchor   — 更新四层记忆中的锚点层
  update_decision — 更新四层记忆中的决策层
  ask_user        — 向用户发出选择题，Agent 暂停等待回答

Agent Loop：每轮 LLM → 解析工具调用 → 执行 → 结果注入对话 → 下一轮；
            无工具调用 / ask_user 触发 / 达到 MAX_LOOP_ITERATIONS 时结束。
"""
import json
import logging
import re
from typing import Any

import httpx

from app.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.admin.settings_store import get_provider_for_scope
from app.guide.help_index import (
    build_guide_content_with_form,
    get_form_for_intent,
    get_help_context_for_llm,
)

logger = logging.getLogger("app.adapters.unified_builtin")

MAX_LOOP_ITERATIONS = 8

# 匹配 ```tool-call\n{json}\n``` 块
_TOOL_CALL_RE = re.compile(r"```tool-call\n([\s\S]*?)```")

_DEFAULT_REPLY = (
    "您可以说：怎么创建项目、怎么加入项目、怎么接入 OpenClaw、怎么发消息、"
    "左边没有项目、@ 没反应、怎么安装、报错排查 等，我会根据说明书为您引导。"
    "也可以直接问项目相关问题，我会结合频道上下文回答。"
)

# 工具使用说明（含 ``` 块，直接拼入 system prompt，不走 .format()）
_TOOLS_DESC = """\
## 可用工具

在回复中嵌入 ```tool-call 块来调用工具（单次回复可包含多个块）：

```tool-call
{"tool": "工具名", "args": {...}}
```

### call_bot — 调用频道内专业 Bot
```tool-call
{"tool": "call_bot", "args": {"username": "bot用户名(不含@)", "message": "发给该Bot的任务描述"}}
```
- 结果会广播到频道并反馈到你的对话中

### update_anchor — 更新项目锚点
```tool-call
{"tool": "update_anchor", "args": {"content": "完整的新锚点内容（覆盖写入）"}}
```

### update_decision — 记录重要决策
```tool-call
{"tool": "update_decision", "args": {"content": "决策内容（覆盖写入）"}}
```

### ask_user — 向用户提问，暂停 Agent 等待回答
```tool-call
{"tool": "ask_user", "args": {"question": "问题标题", "options": ["选项A", "选项B"], "allow_multiple": false}}
```
- 调用后当前轮次立即结束，等待用户选择后自动继续

**规则**：
- 用户消息信息不足、意图模糊或需要关键决策时，**第一步必须调用 ask_user** 收集信息，不要猜测或直接执行
- 先调用所有必要工具，结果返回后再输出最终回复
- 最终回复不含任何 tool-call 块\
"""


# ─── LLM 调用 ────────────────────────────────────────────────────────────────

def _get_llm_config() -> dict | None:
    """优先 guide_bot，依次回退 assistant_bot / orchestrator / system_llm。"""
    for scope in ("guide_bot", "assistant_bot", "orchestrator", "system_llm"):
        cfg = get_provider_for_scope(scope)
        if cfg and cfg.get("base_url") and cfg.get("model"):
            return cfg
    return None


async def _call_llm_messages(messages: list[dict]) -> str | None:
    """多轮对话 LLM 调用，messages 格式为 OpenAI messages 数组。"""
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
    timeout = float(cfg.get("timeout", 600))
    body = {
        "model": cfg["model"],
        "messages": messages,
        "temperature": float(cfg.get("temperature", 0.7)),
        "max_tokens": int(cfg.get("max_tokens", 2000)),
    }
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(url, json=body, headers=headers)
            r.raise_for_status()
            data = r.json()
            choice = (data.get("choices") or [{}])[0]
            return ((choice.get("message") or {}).get("content") or "").strip() or None
    except httpx.TimeoutException as e:
        logger.warning("unified_builtin: LLM timeout (%.0fs, %s)", timeout, type(e).__name__)
        return None
    except Exception as e:
        logger.exception("unified_builtin: LLM request failed: %s", e)
        return None


# ─── 工具解析 ─────────────────────────────────────────────────────────────────

def _parse_tool_calls(text: str) -> list[dict[str, Any]]:
    """从 LLM 回复中提取所有 ```tool-call ... ``` 块，解析为 dict 列表。"""
    calls: list[dict[str, Any]] = []
    for m in _TOOL_CALL_RE.finditer(text):
        try:
            obj = json.loads(m.group(1).strip())
            if isinstance(obj, dict) and "tool" in obj:
                calls.append(obj)
        except (json.JSONDecodeError, AttributeError):
            pass
    return calls


def _strip_tool_calls(text: str) -> str:
    """移除所有 tool-call 块，返回纯文本。"""
    return _TOOL_CALL_RE.sub("", text).strip()


# ─── 工具实现 ─────────────────────────────────────────────────────────────────

async def _exec_update_anchor(args: dict, ctx: dict) -> str:
    content = str(args.get("content") or "").strip()
    if not content:
        return "错误：content 不能为空"
    from app.memory.manager import save_layer
    await save_layer(ctx["channel_id"], "anchor", content)
    logger.info("unified_builtin[tool]: update_anchor channel=%s len=%d", ctx["channel_id"], len(content))
    return "已更新项目锚点"


async def _exec_update_decision(args: dict, ctx: dict) -> str:
    content = str(args.get("content") or "").strip()
    if not content:
        return "错误：content 不能为空"
    from app.memory.manager import save_layer
    await save_layer(ctx["channel_id"], "decisions", content)
    logger.info("unified_builtin[tool]: update_decision channel=%s len=%d", ctx["channel_id"], len(content))
    return "已更新决策记录"


async def _exec_call_bot(args: dict, ctx: dict) -> str:
    username = str(args.get("username") or "").strip().lstrip("@")
    message = str(args.get("message") or "").strip()
    if not username or not message:
        return "错误：需要提供 username 和 message"

    bot_id_by_username: dict = ctx.get("bot_id_by_username") or {}
    adapter_factory = ctx.get("adapter_factory")
    create_and_broadcast = ctx.get("create_and_broadcast")

    if username not in bot_id_by_username:
        available = list(bot_id_by_username.keys())
        return f"错误：频道内没有 @{username}，可用 Bot：{available}"
    if not adapter_factory:
        return "错误：adapter_factory 未注入（内部错误）"

    bot_id = bot_id_by_username[username]
    try:
        adapter = await adapter_factory(bot_id)
        sub_payload = AgentPayload(
            task_id=ctx.get("task_id", ""),
            channel_id=ctx["channel_id"],
            trigger_message={
                "user": ctx.get("sender_id", ""),
                "text": message,
                "timestamp": "",
            },
            memory_context=ctx.get("memory") or {},
            attachments=[],
        )
        resp: AgentResponse = await adapter.execute(sub_payload)
        result = resp.content if resp.success else (resp.error_message or "Bot 执行出错")

        # 广播被调用 Bot 的回复到频道（用户可见）
        if create_and_broadcast:
            await create_and_broadcast(bot_id, result)

        logger.info("unified_builtin[tool]: call_bot @%s completed channel=%s", username, ctx["channel_id"])
        return f"@{username} 回复：\n{result}"
    except Exception as e:
        logger.exception("unified_builtin[tool]: call_bot @%s failed: %s", username, e)
        return f"@{username} 调用出错：{e}"


def _exec_ask_user(args: dict) -> tuple[str, bool]:
    """生成 guide-clarify 选择题消息。返回 (content, should_pause)。"""
    question = str(args.get("question") or "").strip()
    options = args.get("options") or []
    allow_multiple = bool(args.get("allow_multiple", False))

    if not question or len(options) < 2:
        return "错误：ask_user 需要 question 和至少 2 个选项", False

    clarify_schema = {
        "title": question,
        "skip_policy": "allow",
        "questions": [
            {
                "id": "q0",
                "prompt": question,
                "allow_multiple": allow_multiple,
                "options": [{"id": f"a{i}", "label": str(opt)} for i, opt in enumerate(options)],
                "other_enabled": False,
                "other_label": "其他",
                "other_placeholder": "",
            }
        ],
    }
    content = "```guide-clarify\n" + json.dumps(clarify_schema, ensure_ascii=False) + "\n```"
    return content, True


# ─── Agent Loop ───────────────────────────────────────────────────────────────

async def _agent_loop(system_prompt: str, user_text: str, ctx: dict) -> str:
    """
    核心 Agent 循环：
      1. 调用 LLM（携带完整对话历史）
      2. 解析 tool-call 块
      3. 执行工具，将结果注回对话
      4. 重复，直到：无工具调用 / ask_user 触发 / 达到 MAX_LOOP_ITERATIONS

    返回最终回复内容（字符串）。
    """
    messages: list[dict] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_text},
    ]

    for iteration in range(MAX_LOOP_ITERATIONS):
        raw = await _call_llm_messages(messages)
        if not raw:
            logger.warning("unified_builtin: LLM returned empty at iteration %d", iteration)
            break

        tool_calls = _parse_tool_calls(raw)
        if not tool_calls:
            # 无工具调用 → 最终回复
            return _strip_tool_calls(raw)

        # 将含工具调用的 assistant 消息加入历史
        messages.append({"role": "assistant", "content": raw})

        # 执行本轮所有工具
        tool_results: list[str] = []
        pause_content: str = ""
        should_pause: bool = False

        for call in tool_calls:
            tool_name = call.get("tool", "")
            args = call.get("args") or {}

            if tool_name == "call_bot":
                result = await _exec_call_bot(args, ctx)
                tool_results.append(f"[call_bot @{args.get('username', '?')}]: {result}")

            elif tool_name == "update_anchor":
                result = await _exec_update_anchor(args, ctx)
                tool_results.append(f"[update_anchor]: {result}")

            elif tool_name == "update_decision":
                result = await _exec_update_decision(args, ctx)
                tool_results.append(f"[update_decision]: {result}")

            elif tool_name == "ask_user":
                pause_content, should_pause = _exec_ask_user(args)
                tool_results.append("[ask_user]: 已向用户发送选择题，等待回答")

            else:
                tool_results.append(f"[{tool_name}]: 未知工具，跳过")

        logger.info(
            "unified_builtin: agent loop iter=%d tools=%s channel=%s",
            iteration,
            [c.get("tool") for c in tool_calls],
            ctx.get("channel_id", ""),
        )

        if should_pause:
            # ask_user 触发：将 LLM 原文（去掉工具块）+ 选择题一并返回
            prefix = _strip_tool_calls(raw)
            return (prefix + "\n\n" + pause_content).strip() if prefix else pause_content

        # 将工具结果注入对话，继续下一轮
        results_text = "\n".join(tool_results)
        messages.append({
            "role": "user",
            "content": (
                f"工具执行结果：\n{results_text}\n\n"
                "请根据以上结果继续；若所有必要工作已完成，输出最终回复（不含 tool-call 块）。"
            ),
        })

    # 达到上限：取最后一条 assistant 内容作为回复
    logger.warning(
        "unified_builtin: agent loop reached max iterations (%d) channel=%s",
        MAX_LOOP_ITERATIONS,
        ctx.get("channel_id", ""),
    )
    last = next((m["content"] for m in reversed(messages) if m["role"] == "assistant"), "")
    return _strip_tool_calls(last) if last else ""


# ─── Adapter ──────────────────────────────────────────────────────────────────

class UnifiedBuiltinBotAdapter(OpenClawAdapter):
    """统一内置 Bot：Agent Loop 驱动，支持 call_bot / update_anchor / update_decision / ask_user。"""

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        user_text = (payload.trigger_message or {}).get("text") or ""
        memory = payload.memory_context or {}
        channel_id = payload.channel_id
        pconfig = payload.process_config or {}
        channel_bots: list[str] = pconfig.get("channel_bot_usernames") or []
        bot_details: dict = pconfig.get("channel_bot_details") or {}
        bot_id_by_username: dict = pconfig.get("bot_id_by_username") or {}
        adapter_factory = pconfig.get("_adapter_factory")
        create_and_broadcast = pconfig.get("_create_and_broadcast")
        sender_id = (payload.trigger_message or {}).get("user") or ""

        # ── 1. 构建 System Prompt ──────────────────────────────────────────────
        members_lines: list[str] = []
        for uname in channel_bots:
            detail = bot_details.get(uname) or {}
            display = detail.get("display_name") or uname
            desc = detail.get("description") or ""
            caps: list[str] = []
            try:
                intro = json.loads(detail.get("intro") or "{}")
                caps = intro.get("capabilities") or []
            except Exception:
                pass
            line = f"- @{uname}（{display}）"
            if desc:
                line += f"：{desc}"
            if caps:
                line += f"  能力：{'、'.join(caps)}"
            members_lines.append(line)
        members_section = "\n".join(members_lines) if members_lines else "（暂无其他专业 Bot）"

        system_prompt = "\n\n".join([
            "你是 AgentNexus 内置智能协作助手，兼顾使用引导、项目助手、协作协调三个职责。",
            _TOOLS_DESC,
            "=== 系统帮助文档（回答使用类问题时参考）===\n" + get_help_context_for_llm(),
            (
                "=== 四层项目记忆 ===\n"
                f"【锚点·最高优先级】\n{memory.get('anchor') or '（暂无）'}\n\n"
                f"【决策记录】\n{memory.get('decisions') or '（暂无）'}\n\n"
                f"【资料索引】\n{memory.get('files_index') or '（暂无）'}\n\n"
                f"【近期动态】\n{memory.get('recent') or '（暂无）'}"
            ),
            "=== 频道 Bot 成员（可通过 call_bot 调用）===\n" + members_section,
            "请用简洁专业的 Markdown 回答。复杂任务优先借助工具分解处理。",
        ])

        # ── 3. 工具上下文 ──────────────────────────────────────────────────────
        tool_ctx: dict = {
            "channel_id": channel_id,
            "bot_id_by_username": bot_id_by_username,
            "adapter_factory": adapter_factory,
            "create_and_broadcast": create_and_broadcast,
            "memory": memory,
            "task_id": payload.task_id,
            "sender_id": sender_id,
        }

        # ── 4. Agent Loop ──────────────────────────────────────────────────────
        content = await _agent_loop(system_prompt, user_text, tool_ctx)

        # ── 5. 关键词兜底（LLM 不可用时） ────────────────────────────────────
        if not content:
            content = build_guide_content_with_form(user_text) or _DEFAULT_REPLY
            logger.info(
                "unified_builtin: LLM unavailable, keyword fallback channel=%s msg=%s",
                channel_id,
                (user_text[:60] + "…") if len(user_text) > 60 else user_text,
            )

        # ── 6. 附加动态表单（如有匹配意图） ──────────────────────────────────
        form = get_form_for_intent(user_text)
        if form:
            content += "\n\n```guide-form\n" + json.dumps(form, ensure_ascii=False) + "\n```"

        return AgentResponse(content=content, task_id=payload.task_id, success=True)

    async def health_check(self) -> bool:
        return _get_llm_config() is not None

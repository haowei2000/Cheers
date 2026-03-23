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

### update_progress — 更新项目进度
```tool-call
{"tool": "update_progress", "args": {"content": "当前进度、已完成事项、下一步计划（覆盖写入）"}}
```

### ask_user — 向用户提问，暂停 Agent 等待回答
```tool-call
{"tool": "ask_user", "args": {"question": "问题标题", "options": ["选项A", "选项B"], "allow_multiple": false}}
```
- 调用后当前轮次立即结束，等待用户选择后自动继续

### create_file — 将内容保存为 MD 文件，返回下载链接
```tool-call
{"tool": "create_file", "args": {"filename": "文件名（不含扩展名）", "content": "文件的完整 Markdown 内容"}}
```
- 返回可供用户点击下载的链接

**规则**：
- 用户消息信息不足、意图模糊或需要关键决策时，**第一步必须调用 ask_user** 收集信息，不要猜测或直接执行
- 先调用所有必要工具，结果返回后再输出最终回复
- 最终回复不含任何 tool-call 块\
"""


# ─── LLM 调用 ────────────────────────────────────────────────────────────────

def _get_llm_config() -> dict | None:
    """优先 channel_bot，依次回退 orchestrator / system_llm。"""
    for scope in ("channel_bot", "orchestrator", "system_llm"):
        cfg = get_provider_for_scope(scope)
        if cfg and cfg.get("base_url") and cfg.get("model"):
            return cfg
    return None


def _build_llm_http(cfg: dict) -> tuple[str, dict, dict]:
    """Return (url, headers, base_body_fields) for LLM calls."""
    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    if cfg.get("api_key"):
        headers["Authorization"] = f"Bearer {cfg['api_key']}"
    extra = cfg.get("extra_headers")
    if isinstance(extra, dict):
        headers.update({str(k): str(v) for k, v in extra.items()})
    base = {
        "model": cfg["model"],
        "temperature": float(cfg.get("temperature", 0.7)),
        "max_tokens": int(cfg.get("max_tokens", 2000)),
    }
    return url, headers, base


async def _call_llm_messages(messages: list[dict]) -> str | None:
    """多轮对话 LLM 调用，messages 格式为 OpenAI messages 数组。"""
    cfg = _get_llm_config()
    if not cfg:
        return None
    url, headers, base = _build_llm_http(cfg)
    timeout = float(cfg.get("timeout", 600))
    body = {**base, "messages": messages}
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


_TOOL_CALL_START = "```tool-call"


async def _stream_llm_filtered(messages: list[dict], token_cb) -> str | None:
    """
    Stream LLM response, suppressing tool-call blocks from the token stream.
    Text outside tool-call blocks is forwarded to token_cb character-by-character;
    the full raw response (including tool-call blocks) is returned for parsing.
    """
    cfg = _get_llm_config()
    if not cfg:
        return None
    url, headers, base = _build_llm_http(cfg)
    timeout = float(cfg.get("timeout", 600))
    body = {**base, "messages": messages, "stream": True}

    full = ""
    pending = ""        # lookahead buffer to detect ```tool-call start
    in_tool = False
    tool_buf = ""
    _lookahead = len(_TOOL_CALL_START)

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
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
                        token = ((chunk.get("choices") or [{}])[0].get("delta") or {}).get("content") or ""
                    except (json.JSONDecodeError, KeyError):
                        continue
                    if not token:
                        continue
                    full += token

                    if in_tool:
                        tool_buf += token
                        # Closing ``` after the opening line signals end of tool block
                        if "```" in tool_buf[len(_TOOL_CALL_START):]:
                            in_tool = False
                            tool_buf = ""
                    else:
                        pending += token
                        idx = pending.find(_TOOL_CALL_START)
                        if idx >= 0:
                            if idx > 0 and token_cb:
                                await token_cb(pending[:idx])
                            in_tool = True
                            tool_buf = pending[idx:]
                            pending = ""
                        else:
                            safe_len = max(0, len(pending) - _lookahead)
                            if safe_len > 0 and token_cb:
                                await token_cb(pending[:safe_len])
                            pending = pending[safe_len:]

        if pending and not in_tool and token_cb:
            await token_cb(pending)

    except httpx.TimeoutException as e:
        logger.warning("unified_builtin: stream LLM timeout (%.0fs, %s)", timeout, type(e).__name__)
    except Exception as e:
        logger.exception("unified_builtin: stream LLM failed: %s", e)

    return full.strip() or None


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


def _merge_attachments_into_text(user_text: str, attachments: list[dict[str, str]] | None) -> str:
    """将文件解析结果拼接进内置 Bot 的用户消息。"""
    if not attachments:
        return user_text
    parts = [user_text.strip(), "", "以下是用户上传文件的解析结果，请结合这些内容处理："]
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
            parts.append("注意: 该文件文本已按长度限制截断。")
        parts.append("")
    return "\n".join(parts).strip()


def _build_vision_content(user_text: str, attachments: list[dict[str, str]] | None) -> list[dict]:
    """将文本和图片附件构建为 OpenAI Vision 格式的多模态 content 数组。"""
    parts: list[dict] = [{"type": "text", "text": user_text}]
    for att in (attachments or []):
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


def _build_attachment_fallback_reply(user_text: str, attachments: list[dict[str, str]] | None) -> str:
    """LLM 不可用时，基于已解析的附件内容给出保底回答。"""
    if not attachments:
        return ""
    normalized = (user_text or "").lower()
    wants_summary = any(keyword in normalized for keyword in ("概括", "摘要", "总结", "概述", "summary", "summar"))
    sections = ["当前 LLM 服务暂时不可用，但我已经成功读取了上传文件内容。"]
    for index, attachment in enumerate(attachments, start=1):
        filename = attachment.get("filename") or attachment.get("file_id") or f"文件 {index}"
        summary = (attachment.get("summary") or "").strip()
        content = (attachment.get("content") or "").strip()
        excerpt = content[:280].strip()
        if len(content) > 280:
            excerpt += "..."
        sections.append(f"### 文件 {index}: {filename}")
        if wants_summary:
            sections.append("基于已解析文本的概括：")
            if summary:
                sections.append(summary)
            elif excerpt:
                sections.append(f"- {excerpt}")
            else:
                sections.append("- 文件已读取，但暂时没有可提取的文本内容。")
        else:
            if summary:
                sections.append("我先提取出文件的关键内容：")
                sections.append(summary)
            elif excerpt:
                sections.append("我先提取出文件的关键片段：")
                sections.append(f"- {excerpt}")
            else:
                sections.append("文件已读取，但暂时没有可提取的文本内容。")
    sections.append("如果你配置好可用的 LLM 服务后再次提问，我会在完整上下文上继续给出更深入的回答。")
    return "\n\n".join(part for part in sections if part).strip()


# ─── 工具实现 ─────────────────────────────────────────────────────────────────

async def _exec_update_anchor(args: dict, ctx: dict) -> str:
    content = str(args.get("content") or "").strip()
    if not content:
        return "错误：content 不能为空"
    from app.memory.manager import save_layer
    await save_layer(ctx["channel_id"], "anchor", content)
    logger.info("unified_builtin[tool]: update_anchor channel=%s len=%d", ctx["channel_id"], len(content))
    return "已更新项目锚点"


async def _exec_update_progress(args: dict, ctx: dict) -> str:
    content = str(args.get("content") or "").strip()
    if not content:
        return "错误：content 不能为空"
    from app.memory.manager import save_layer
    await save_layer(ctx["channel_id"], "progress", content)
    logger.info("unified_builtin[tool]: update_progress channel=%s len=%d", ctx["channel_id"], len(content))
    return "已更新项目进度"


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
            attachments=ctx.get("attachments") or [],
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


async def _exec_create_file(args: dict, ctx: dict) -> str:
    """将内容保存为 MD 文件，写入 FileRecord，返回下载路径。"""
    import uuid
    from datetime import datetime, timezone
    from pathlib import Path

    filename = re.sub(r'[^\w\-. ]', '_', str(args.get("filename") or "output").strip()) or "output"
    content = str(args.get("content") or "").strip()
    if not content:
        return "错误：content 不能为空"

    from app.config import settings
    from app.db.models import FileRecord

    file_id = str(uuid.uuid4())
    channel_id = ctx["channel_id"]

    base = Path(settings.data_dir)
    if not base.is_absolute():
        base = Path(__file__).resolve().parent.parent.parent / settings.data_dir
    gen_dir = base / "generated" / channel_id
    gen_dir.mkdir(parents=True, exist_ok=True)

    md_path = gen_dir / f"{file_id}.md"
    md_path.write_text(content, encoding="utf-8")

    original_filename = f"{filename}.md"
    now = datetime.now(timezone.utc)

    record = FileRecord(
        file_id=file_id,
        channel_id=channel_id,
        uploader_id=ctx.get("sender_id") or "system",
        original_path=str(md_path),
        original_filename=original_filename,
        content_type="text/markdown",
        size_bytes=len(content.encode("utf-8")),
        md_path=str(md_path),
        status="ready",
        uploaded_at=now,
        converted_at=now,
    )
    db_session = ctx.get("_db_session")
    if db_session:
        # 复用 orchestrator 的已有 session，避免 SQLite 写锁冲突；由外层统一 commit
        db_session.add(record)
        await db_session.flush()
    else:
        from app.db.session import async_session_factory
        async with async_session_factory() as s:
            s.add(record)
            await s.commit()

    download_url = f"/api/files/{file_id}/download"
    logger.info("unified_builtin[tool]: create_file %s channel=%s", original_filename, channel_id)
    return f"文件已创建：[{original_filename}]({download_url})\n\n下载链接：`{download_url}`"


# ─── Agent Loop ───────────────────────────────────────────────────────────────

def _tool_label(tool_name: str, args: dict) -> str:
    """Human-readable label for a tool call notification."""
    if tool_name == "call_bot":
        return f"调用 @{args.get('username', '?')}"
    if tool_name == "update_anchor":
        return "更新项目锚点"
    if tool_name == "update_decision":
        return "记录决策"
    if tool_name == "update_progress":
        return "更新项目进度"
    if tool_name == "ask_user":
        return "向用户提问"
    if tool_name == "create_file":
        return f"创建文件 {args.get('filename', '?')}.md"
    return tool_name


async def _agent_loop(system_prompt: str, user_content: str | list, ctx: dict, stream_cb=None) -> str:
    """
    核心 Agent 循环：
      1. 调用 LLM（携带完整对话历史）；若有 stream_cb 则流式输出可见文本
      2. 解析 tool-call 块，通过 stream_cb 发出工具调用通知
      3. 执行工具，将结果注回对话
      4. 重复，直到：无工具调用 / ask_user 触发 / 达到 MAX_LOOP_ITERATIONS

    user_content 可以是 str（纯文本）或 list[dict]（OpenAI Vision 多模态格式）。
    返回最终回复内容（字符串）。
    """
    messages: list[dict] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]

    for iteration in range(MAX_LOOP_ITERATIONS):
        # 流式调用 LLM，过滤掉 tool-call 块的可见输出
        if stream_cb:
            raw = await _stream_llm_filtered(messages, stream_cb)
            if not raw:
                logger.info("unified_builtin: streaming returned empty, fallback to non-stream mode")
                raw = await _call_llm_messages(messages)
        else:
            raw = await _call_llm_messages(messages)

        if not raw:
            logger.warning("unified_builtin: LLM returned empty at iteration %d", iteration)
            break

        tool_calls = _parse_tool_calls(raw)
        if not tool_calls:
            # 无工具调用 → 最终回复（已流式输出完毕）
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

            # 通知前端：工具调用开始
            if stream_cb:
                label = _tool_label(tool_name, args)
                await stream_cb(f"\n\n`🔧 {label}…`")

            if tool_name == "call_bot":
                result = await _exec_call_bot(args, ctx)
                tool_results.append(f"[call_bot @{args.get('username', '?')}]: {result}")

            elif tool_name == "update_anchor":
                result = await _exec_update_anchor(args, ctx)
                tool_results.append(f"[update_anchor]: {result}")

            elif tool_name == "update_decision":
                result = await _exec_update_decision(args, ctx)
                tool_results.append(f"[update_decision]: {result}")

            elif tool_name == "update_progress":
                result = await _exec_update_progress(args, ctx)
                tool_results.append(f"[update_progress]: {result}")

            elif tool_name == "ask_user":
                pause_content, should_pause = _exec_ask_user(args)
                tool_results.append("[ask_user]: 已向用户发送选择题，等待回答")

            elif tool_name == "create_file":
                result = await _exec_create_file(args, ctx)
                tool_results.append(f"[create_file]: {result}")

            else:
                tool_results.append(f"[{tool_name}]: 未知工具，跳过")

            # 通知前端：工具调用完成
            if stream_cb and tool_name != "ask_user":
                await stream_cb(" ✓\n")

        logger.info(
            "unified_builtin: agent loop iter=%d tools=%s channel=%s",
            iteration,
            [c.get("tool") for c in tool_calls],
            ctx.get("channel_id", ""),
        )

        if should_pause:
            prefix = _strip_tool_calls(raw)
            if stream_cb:
                # ask_user 选择题内容不走 stream（由 message_done 一次性展示）
                pass
            return (prefix + "\n\n" + pause_content).strip() if prefix else pause_content

        # 将工具结果注入对话，继续下一轮
        if stream_cb:
            await stream_cb("\n\n")
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
        all_attachments = payload.attachments or []

        # 分离图片与文档附件
        image_attachments = [a for a in all_attachments if a.get("is_image") == "true"]
        doc_attachments = [a for a in all_attachments if a.get("is_image") != "true"]

        # 文档附件合并为文本
        user_text = _merge_attachments_into_text(user_text, doc_attachments)

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
                "=== 项目记忆 ===\n"
                f"【锚点·最高优先级】\n{memory.get('anchor') or '（暂无）'}\n\n"
                f"【项目进度】\n{memory.get('progress') or '（暂无）'}\n\n"
                f"【决策记录】\n{memory.get('decisions') or '（暂无）'}\n\n"
                f"【资料索引】\n{memory.get('files_index') or '（暂无）'}\n\n"
                f"【近期动态】\n{memory.get('recent') or '（暂无）'}"
            ),
            "=== 频道 Bot 成员（可通过 call_bot 调用）===\n" + members_section,
            (
                "## 记忆维护职责（必须严格执行）\n\n"
                "在每次对话中，你必须主动判断是否需要更新以下记忆层，**不要等用户主动要求**：\n\n"
                "- **update_anchor**：若用户提到项目目标、范围、核心约束、背景发生变化，或锚点为空，立即更新。"
                "锚点是最高优先级记忆，必须始终保持最新、准确。\n"
                "- **update_progress**：若用户汇报进展、完成了某项任务、提到阶段成果、当前卡点或下一步计划，立即更新进度。"
                "进度文件应包含：已完成事项、当前状态、下一步计划。\n"
                "- **update_decision**：若对话中产生了重要决策、技术选型、方案确认，立即记录。\n\n"
                "**触发原则**：宁可多更新，不要遗漏。每轮对话结束前，先检查是否有需要持久化的信息，再输出最终回复。\n\n"
                "请用简洁专业的 Markdown 回答。复杂任务优先借助工具分解处理。"
            ),
        ])

        # ── 3. 澄清回答自动存入 decisions ─────────────────────────────────────
        _CLARIFY_PREFIX = "@channel bot 澄清回答："
        if user_text.startswith(_CLARIFY_PREFIX):
            answer_body = user_text[len(_CLARIFY_PREFIX):].strip()
            if answer_body:
                from app.memory.manager import save_layer
                from datetime import datetime, timezone
                ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
                entry = f"### 用户澄清选择（{ts}）\n{answer_body}"
                existing = (memory.get("decisions") or "").rstrip()
                new_decisions = f"{existing}\n\n{entry}".strip() if existing else entry
                await save_layer(channel_id, "decisions", new_decisions)
                memory = dict(memory)
                memory["decisions"] = new_decisions
                logger.info("unified_builtin: clarify answer saved to decisions channel=%s", channel_id)

        # ── 4. 工具上下文 ──────────────────────────────────────────────────────
        tool_ctx: dict = {
            "channel_id": channel_id,
            "bot_id_by_username": bot_id_by_username,
            "adapter_factory": adapter_factory,
            "create_and_broadcast": create_and_broadcast,
            "memory": memory,
            "task_id": payload.task_id,
            "sender_id": sender_id,
            "attachments": payload.attachments or [],
            "_db_session": pconfig.get("_db_session"),
        }

        # ── 5. Agent Loop（支持 Vision 多模态）────────────────────────────────
        stream_cb = pconfig.get("_stream_token")
        cfg = _get_llm_config()
        supports_vision = (cfg or {}).get("supports_vision", True) if cfg else True

        if supports_vision and any(a.get("image_b64") for a in image_attachments):
            user_content: str | list = _build_vision_content(user_text, image_attachments)
        else:
            if image_attachments:
                user_text += "\n\n（注：当前 LLM 未启用图片识别，已忽略图片附件。）"
            user_content = user_text

        content = await _agent_loop(system_prompt, user_content, tool_ctx, stream_cb=stream_cb)

        # ── 6. 关键词兜底（LLM 不可用时） ────────────────────────────────────
        if not content:
            content = (
                _build_attachment_fallback_reply(user_text, payload.attachments)
                or build_guide_content_with_form(user_text)
                or _DEFAULT_REPLY
            )
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

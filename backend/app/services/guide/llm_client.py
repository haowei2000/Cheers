"""引导 Bot 使用的 LLM 客户端（OpenAI 兼容）。由管理端「功能绑定」选择 LLM。"""
import json
import logging
import re
from typing import Any

import httpx

from app.services.admin.settings_store import get_provider_for_scope

logger = logging.getLogger("app.services.guide.llm_client")


def _config() -> dict | None:
    return get_provider_for_scope("channel_bot")


def _base_url() -> str:
    c = _config()
    return (c.get("base_url") or "").strip() if c else ""


def _model() -> str:
    c = _config()
    return (c.get("model") or "").strip() if c else ""


def is_configured() -> bool:
    """是否已配置引导 LLM。"""
    return bool(_base_url() and _model())


def _ollama_base() -> str | None:
    """若为 Ollama（base_url 含 11434），返回根地址如 http://localhost:11434。"""
    base = _base_url().strip()
    if not base or "11434" not in base:
        return None
    base = base.rstrip("/")
    if base.endswith("/v1"):
        return base[:-3]
    return base


# 健康检查时 503 视为“可达但繁忙”，不作为完全不可用
CONNECTION_503_BUSY = "503_busy"


async def check_connection() -> tuple[bool, str]:
    """
    检查本地 LLM 是否可连通。
    Ollama：GET /api/tags，单次请求 8s；200 或 503 均视为 ok（503 表示忙于推理），仅连不上才报错。
    其它：发一条最小 chat 请求；503 同样视为 503_busy。
    返回 (True, "") 表示成功；(True, "503_busy") 表示可达但繁忙；(False, "原因") 表示失败或未配置。
    """
    if not is_configured():
        return False, "not_configured"
    c = _config()
    base = _base_url().strip()
    ollama_root = _ollama_base()
    if ollama_root:
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                r = await client.get(f"{ollama_root}/api/tags")
                if r.status_code == 200:
                    return True, ""
                if r.status_code == 503:
                    # Ollama 忙于推理时返回 503，服务本身是正常的
                    return True, ""
                return False, f"{r.status_code}"
        except (httpx.ConnectError, httpx.ConnectTimeout):
            return False, "connection_refused"
        except httpx.ReadTimeout:
            return False, "timeout"
        except Exception as e:
            return False, str(e).strip() or type(e).__name__ or "unknown"
    url = base.rstrip("/") + "/chat/completions"
    payload = {
        "model": _model(),
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 10,
    }
    headers = {"Content-Type": "application/json"}
    if c and (c.get("api_key") or "").strip():
        headers["Authorization"] = f"Bearer {(c.get('api_key') or '').strip()}"
    extra = (c or {}).get("extra_headers")
    if isinstance(extra, dict):
        headers.update({str(k): str(v) for k, v in extra.items()})
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.post(url, json=payload, headers=headers)
            r.raise_for_status()
            data = r.json()
            if data.get("choices") and data["choices"][0].get("message", {}).get("content"):
                return True, ""
            return False, "empty_response"
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 503:
            return True, CONNECTION_503_BUSY
        if e.response.status_code == 502:
            return False, "502"
        try:
            body = e.response.text
        except Exception:
            body = ""
        logger.error(
            "check_connection HTTP %d: url=%s body=%s",
            e.response.status_code,
            url,
            body[:1000] if body else "(empty)",
        )
        return False, f"{e.response.status_code}"
    except (httpx.ConnectError, httpx.ConnectTimeout):
        return False, "connection_refused"
    except Exception as e:
        return False, str(e).strip() or type(e).__name__ or "unknown"


async def chat(system_prompt: str, user_message: str) -> str | None:
    """
    调用 OpenAI 兼容的 chat completions 接口，返回 assistant 的 content。
    失败或未配置时返回 None。
    """
    if not is_configured():
        return None
    c = _config()
    base = _base_url()
    url = base.rstrip("/") + "/chat/completions"
    payload = {
        "model": _model(),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        "temperature": float(c.get("temperature", 0.7)) if c else 0.7,
        "max_tokens": int(c.get("max_tokens", 1000)) if c else 1000,
    }
    headers = {"Content-Type": "application/json"}
    if c and (c.get("api_key") or "").strip():
        headers["Authorization"] = f"Bearer {(c.get('api_key') or '').strip()}"
    extra = (c or {}).get("extra_headers")
    if isinstance(extra, dict):
        headers.update({str(k): str(v) for k, v in extra.items()})
    timeout = float(c.get("timeout", 600)) if c else 600.0
    try:
        logger.info(
            "guide llm request: model=%s user_msg=%s",
            _model(),
            (user_message[:80] + "…") if len(user_message) > 80 else user_message,
        )
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(url, json=payload, headers=headers)
            r.raise_for_status()
            data = r.json()
            choice = data.get("choices")
            if choice and len(choice) > 0:
                content = choice[0].get("message", {}).get("content")
                if isinstance(content, str) and content.strip():
                    return content.strip()
    except httpx.TimeoutException as e:
        logger.warning(
            "guide llm request timed out after %.0fs (%s): url=%s",
            timeout, type(e).__name__, url,
        )
    except httpx.HTTPStatusError as e:
        try:
            body = e.response.text
        except Exception:
            body = ""
        logger.error(
            "guide llm HTTP %d: url=%s body=%s",
            e.response.status_code,
            str(e.request.url),
            body[:1000] if body else "(empty)",
        )
    except Exception as e:
        logger.warning(
            "guide llm request failed (%s): %s",
            type(e).__name__,
            str(e) or "(no message)",
        )
    return None


def _extract_json_object(text: str) -> dict[str, Any] | None:
    raw = (text or "").strip()
    if not raw:
        return None
    # 优先直解析
    try:
        obj = json.loads(raw)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    # 尝试提取 ```json ... ``` 代码块
    m = re.search(r"```json\s*([\s\S]*?)```", raw, re.IGNORECASE)
    if m:
        try:
            obj = json.loads(m.group(1).strip())
            if isinstance(obj, dict):
                return obj
        except Exception:
            return None
    return None


def _normalize_clarify_schema(data: dict[str, Any]) -> dict[str, Any] | None:
    questions = data.get("questions")
    if not isinstance(questions, list) or not questions:
        return None
    normalized_questions: list[dict[str, Any]] = []
    for idx, q in enumerate(questions):
        if not isinstance(q, dict):
            continue
        prompt = str(q.get("prompt") or "").strip()
        options = q.get("options")
        if not prompt or not isinstance(options, list) or len(options) < 2:
            continue
        normalized_opts: list[dict[str, Any]] = []
        for oid, opt in enumerate(options):
            if not isinstance(opt, dict):
                continue
            label = str(opt.get("label") or "").strip()
            opt_id = str(opt.get("id") or f"opt_{oid}").strip()
            if not label:
                continue
            item: dict[str, Any] = {"id": opt_id, "label": label}
            if opt.get("requires_text"):
                item["requires_text"] = True
                item["text_placeholder"] = str(opt.get("text_placeholder") or "请输入").strip()
            normalized_opts.append(item)
        if len(normalized_opts) < 2:
            continue
        normalized_questions.append(
            {
                "id": str(q.get("id") or f"q_{idx}"),
                "prompt": prompt,
                "allow_multiple": bool(q.get("allow_multiple", False)),
                "options": normalized_opts,
                "other_enabled": bool(q.get("other_enabled", False)),
                "other_label": str(q.get("other_label") or "其他"),
                "other_placeholder": str(q.get("other_placeholder") or "请输入其他补充"),
            }
        )
    if not normalized_questions:
        return None
    skip_policy = "allow" if str(data.get("skip_policy") or "allow").lower() == "allow" else "forbid"
    out: dict[str, Any] = {
        "title": str(data.get("title") or "请先确认以下问题").strip(),
        "questions": normalized_questions,
        "skip_policy": skip_policy,
    }
    reason = str(data.get("reason") or "").strip()
    if reason:
        out["reason"] = reason
    score = data.get("score")
    try:
        if score is not None:
            out["_score"] = max(0.0, min(1.0, float(score)))
    except (TypeError, ValueError):
        pass
    return out


async def generate_clarify_schema(user_message: str, help_context: str) -> dict[str, Any] | None:
    """让 LLM 生成澄清问题 JSON；失败返回 None。"""
    if not is_configured():
        return None
    system_prompt = (
        "你是企业应用的需求澄清助手。请判断用户提问是否信息不足。"
        "若不需要澄清，只返回JSON: {\"need_clarify\": false}。"
        "若需要澄清，返回JSON: "
        "{\"need_clarify\": true, \"title\": \"...\", \"skip_policy\": \"allow|forbid\", "
        "\"questions\": [{\"id\":\"...\",\"prompt\":\"...\",\"allow_multiple\":false,"
        "\"options\":[{\"id\":\"a\",\"label\":\"选项A\"},{\"id\":\"b\",\"label\":\"选项B\","
        "\"requires_text\":true,\"text_placeholder\":\"请输入地址或说明\"}]}], "
        "\"reason\":\"...\"}。"
        "必须是纯 JSON，不要输出其他文字。"
        "问题应简短、可选项清晰，允许一次给 1~3 个问题。"
        "若某选项选中后需要用户补充文字（如地址、URL、具体说明），为该选项加上 "
        "\"requires_text\": true 和 \"text_placeholder\": \"提示文案\"，不要将「请输入…」写在 label 里。\n\n"
        f"参考文档上下文:\n{help_context}"
    )
    content = await chat(system_prompt, user_message)
    if not content:
        return None
    obj = _extract_json_object(content)
    if not obj:
        return None
    if not bool(obj.get("need_clarify", False)):
        return None
    return _normalize_clarify_schema(obj)

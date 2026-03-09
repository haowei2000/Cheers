"""引导 Bot 使用的 LLM 客户端（OpenAI 兼容）。由管理端「功能绑定」选择 LLM。"""
import logging

import httpx

from app.admin.settings_store import get_provider_for_scope

logger = logging.getLogger("app.guide.llm_client")


def _config() -> dict | None:
    return get_provider_for_scope("guide_bot")


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
    try:
        logger.info(
            "guide llm request: model=%s user_msg=%s",
            _model(),
            (user_message[:80] + "…") if len(user_message) > 80 else user_message,
        )
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(url, json=payload, headers=headers)
            r.raise_for_status()
            data = r.json()
            choice = data.get("choices")
            if choice and len(choice) > 0:
                content = choice[0].get("message", {}).get("content")
                if isinstance(content, str) and content.strip():
                    return content.strip()
    except Exception as e:
        logger.warning("guide llm request failed (using keyword fallback): %s", e)
    return None

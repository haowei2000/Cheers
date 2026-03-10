"""管理端 API：LLM 设置、日志拉取、LLM 辅助排查。"""
import asyncio
import logging
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.admin.log_buffer import get_formatted_log_excerpt, get_recent_logs
from app.admin.settings_store import (
    create_llm_provider,
    delete_llm_provider,
    get_clarify_settings,
    get_llm_bindings,
    get_llm_providers_list,
    get_provider_for_scope,
    set_clarify_settings,
    set_llm_bindings,
    update_llm_provider,
)

logger = logging.getLogger("app.admin")

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ---------- LLM 设置（一层：设定列表 二层：功能绑定） ----------


@router.get("/settings/llm")
async def get_llm_settings() -> dict:
    """获取 LLM 设定列表与功能绑定。"""
    logger.info("GET /api/admin/settings/llm 请求")
    return {
        "status": "success",
        "data": {
            "providers": get_llm_providers_list(),
            "bindings": get_llm_bindings(),
        },
    }


class LLMProviderBody(BaseModel):
    name: str = ""
    base_url: str = ""
    model: str = ""
    api_key: str = ""
    temperature: float = 0.7
    max_tokens: int = 1000


@router.post("/settings/llm/providers")
async def post_llm_provider(body: LLMProviderBody) -> dict:
    """新增一个 LLM 设定。"""
    logger.info("POST /api/admin/settings/llm/providers 请求 name=%s base_url=%s model=%s", body.name, body.base_url, body.model)
    pid = create_llm_provider(
        name=body.name,
        base_url=body.base_url,
        model=body.model,
        api_key=body.api_key,
        temperature=body.temperature,
        max_tokens=body.max_tokens,
    )
    logger.info("POST /api/admin/settings/llm/providers 成功 provider_id=%s", pid)
    return {"status": "success", "data": {"id": pid, "providers": get_llm_providers_list()}}  # type: ignore[return-value]


@router.put("/settings/llm/providers/{provider_id}")
async def put_llm_provider(provider_id: str, body: LLMProviderBody) -> dict:
    """修改指定 LLM 设定。api_key 传空表示不修改密钥。"""
    ok = update_llm_provider(
        provider_id,
        name=body.name,
        base_url=body.base_url,
        model=body.model,
        api_key=body.api_key,
        temperature=body.temperature,
        max_tokens=body.max_tokens,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="LLM 不存在")
    return {"status": "success", "data": {"providers": get_llm_providers_list()}}  # type: ignore[return-value]


@router.delete("/settings/llm/providers/{provider_id}")
async def delete_llm_provider_route(provider_id: str) -> dict:
    """删除指定 LLM 设定（并清除使用该设定的功能绑定）。"""
    ok = delete_llm_provider(provider_id)
    if not ok:
        raise HTTPException(status_code=404, detail="LLM 不存在")
    return {"status": "success", "data": {"providers": get_llm_providers_list(), "bindings": get_llm_bindings()}}  # type: ignore[return-value]


class LLMBindingsBody(BaseModel):
    guide_bot: str | None = None
    system_llm: str | None = None
    log_analyze: str | None = None
    qa_summarize: str | None = None


@router.put("/settings/llm/bindings")
async def put_llm_bindings(body: LLMBindingsBody) -> dict:
    """更新功能绑定：各功能使用哪个 LLM（传 provider id，传空串表示不绑定）。"""
    set_llm_bindings(
        guide_bot=body.guide_bot,
        system_llm=body.system_llm,
        log_analyze=body.log_analyze,
        qa_summarize=body.qa_summarize,
    )
    return {"status": "success", "data": {"bindings": get_llm_bindings()}}  # type: ignore[return-value]


class ClarifySettingsBody(BaseModel):
    clarify_strict_mode: bool | None = None
    clarify_force_rule: bool | None = None
    clarify_threshold: float | None = None


@router.get("/settings/clarify")
async def get_admin_clarify_settings() -> dict:
    """获取澄清策略设置。"""
    return {
        "status": "success",
        "message": "ok",
        "data": get_clarify_settings(),
    }


@router.put("/settings/clarify")
async def put_admin_clarify_settings(body: ClarifySettingsBody) -> dict:
    """更新澄清策略设置。"""
    updated = set_clarify_settings(
        clarify_strict_mode=body.clarify_strict_mode,
        clarify_force_rule=body.clarify_force_rule,
        clarify_threshold=body.clarify_threshold,
    )
    return {
        "status": "success",
        "message": "updated",
        "data": updated,
    }


# ---------- 日志（面向 LLM） ----------


@router.get("/logs")
async def admin_logs(
    level: str | None = None,
    limit: int = 200,
) -> dict:
    """
    获取最近日志。格式面向 LLM 排查：timestamp | level | logger | [context] | message | [traceback]。
    level 可选：DEBUG/INFO/WARNING/ERROR。
    """
    entries = get_recent_logs(level=level, limit=limit)
    return {"status": "success", "data": {"entries": entries, "formatted_excerpt": get_formatted_log_excerpt(level=level, limit=limit)}}


class LogAnalyzeBody(BaseModel):
    log_excerpt: str = ""
    question: str = ""


class QaPairItem(BaseModel):
    question: str = ""
    answer: str = ""
    question_time: str = ""
    answer_time: str = ""


class QaSummarizeBody(BaseModel):
    channel_name: str = ""
    pairs: list[QaPairItem] = []


@router.post("/logs/analyze")
async def analyze_logs_with_llm(body: LogAnalyzeBody) -> dict:
    """
    将日志摘要与可选问题发给「日志分析」绑定的 LLM，返回分析建议。
    未绑定则使用「系统 LLM」绑定。
    """
    c = get_provider_for_scope("log_analyze") or get_provider_for_scope("system_llm")
    if not c:
        raise HTTPException(
            status_code=400,
            detail="请先在管理页「LLM 参数」中添加 LLM 设定，并在「功能绑定」中为「日志分析」或「系统 LLM」选择 LLM。",
        )
    base_url = (c.get("base_url") or "").strip()
    api_key = (c.get("api_key") or "").strip()
    model = (c.get("model") or "gpt-4o-mini").strip()
    if not base_url:
        raise HTTPException(status_code=400, detail="所选 LLM 的 Base URL 为空")
    log_text = (body.log_excerpt or "").strip()
    if not log_text:
        log_text = get_formatted_log_excerpt(level="ERROR", limit=50)
    if not log_text:
        return {"status": "success", "data": {"analysis": "暂无错误日志可分析。"}}
    user_content = f"以下是一段系统错误日志（格式为 timestamp | level | logger | message，可能含 traceback）：\n\n{log_text}"
    if body.question.strip():
        user_content += f"\n\n用户问题：{body.question.strip()}"
    user_content += "\n\n请以运维助手身份分析：可能原因、建议排查步骤（简短分条）。"
    try:
        url = f"{base_url.rstrip('/')}/chat/completions"
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": "你是运维与故障排查助手。根据错误日志给出可能原因和可操作的排查步骤，回答简洁、分条。"},
                {"role": "user", "content": user_content},
            ],
            "max_tokens": 1500,
        }
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(url, json=payload, headers=headers)
            r.raise_for_status()
            data = r.json()
            content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
            return {"status": "success", "data": {"analysis": content.strip() or "无分析结果"}}
    except httpx.HTTPStatusError as e:
        code = e.response.status_code
        if code == 503:
            detail = "Ollama/LLM 返回 503（服务繁忙或模型加载中），请稍后重试。"
        else:
            detail = f"LLM 请求失败: {code}"
        logger.warning("logs/analyze HTTP %s: %s", code, e)
        raise HTTPException(status_code=502, detail=detail)
    except Exception as e:
        logger.exception("logs/analyze: %s", e)
        raise HTTPException(status_code=500, detail=f"分析失败: {e!s}")


@router.post("/qa/summarize")
async def summarize_qa_with_llm(body: QaSummarizeBody) -> dict:
    """将一组问答发送给 LLM，总结为详细 Markdown 文档。默认使用 qa_summarize 绑定，未绑定则回退 system_llm。"""
    if not body.pairs:
        raise HTTPException(status_code=400, detail="请至少提供一组问答")
    c = get_provider_for_scope("qa_summarize") or get_provider_for_scope("system_llm")
    if not c:
        raise HTTPException(
            status_code=400,
            detail="请先在管理页「LLM 参数」中添加 LLM 设定，并在「功能绑定」中为「问答总结」或「系统 LLM」选择 LLM。",
        )
    base_url = (c.get("base_url") or "").strip()
    api_key = (c.get("api_key") or "").strip()
    model = (c.get("model") or "gpt-4o-mini").strip()
    if not base_url:
        raise HTTPException(status_code=400, detail="所选 LLM 的 Base URL 为空")

    channel_name = (body.channel_name or "").strip() or "频道"
    lines: list[str] = []
    for idx, item in enumerate(body.pairs, start=1):
        lines.append(f"## 问答 {idx}")
        lines.append(f"问题时间: {item.question_time or '-'}")
        lines.append(f"回答时间: {item.answer_time or '-'}")
        lines.append("")
        lines.append("### 问题")
        lines.append(item.question.strip() or "-")
        lines.append("")
        lines.append("### 回答")
        lines.append(item.answer.strip() or "-")
        lines.append("")
    qa_text = "\n".join(lines)
    prompt = (
        f"频道：{channel_name}\n"
        f"共有 {len(body.pairs)} 组问答。\n\n"
        "请根据以下问答整理一份详细且结构化的 Markdown 文档，需包含：\n"
        "1) 背景与目标\n2) 关键问题与结论\n3) 详细步骤/方法\n4) 注意事项与风险\n5) 后续建议\n\n"
        "要求：\n"
        "- 使用清晰的 Markdown 标题层级\n"
        "- 不要输出与原问答无关的内容\n"
        "- 尽量保留关键细节，不要过度简写\n\n"
        f"问答原文：\n\n{qa_text}"
    )
    try:
        url = f"{base_url.rstrip('/')}/chat/completions"
        payload = {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": "你是资深技术文档整理助手，擅长将问答记录整理为清晰、完整、可执行的 Markdown 文档。",
                },
                {"role": "user", "content": prompt},
            ],
            "max_tokens": 2000,
        }
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        async with httpx.AsyncClient(timeout=90.0) as client:
            r = await client.post(url, json=payload, headers=headers)
            r.raise_for_status()
            data = r.json()
            content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
            return {"status": "success", "data": {"summary_markdown": content.strip() or "无总结结果"}}
    except httpx.HTTPStatusError as e:
        code = e.response.status_code
        detail = "LLM 请求失败: 503（服务繁忙或模型加载中）" if code == 503 else f"LLM 请求失败: {code}"
        logger.warning("qa/summarize HTTP %s: %s", code, e)
        raise HTTPException(status_code=502, detail=detail)
    except Exception as e:
        logger.exception("qa/summarize: %s", e)
        raise HTTPException(status_code=500, detail=f"总结失败: {e!s}")


# ---------- 系统状态（可选） ----------


async def _health_database_async() -> str:
    try:
        from sqlalchemy import text
        from app.db.session import async_engine
        async with async_engine.connect() as conn:
            await asyncio.wait_for(conn.execute(text("SELECT 1")), timeout=5.0)
        return "ok"
    except asyncio.TimeoutError:
        return "error: timeout"
    except Exception as e:
        return f"error: {e!s}"


def _health_redis_sync() -> str:
    try:
        import redis
        from app.config import settings
        r = redis.from_url(
            settings.redis_url,
            socket_connect_timeout=2,
            socket_timeout=2,
        )
        r.ping()
        return "ok"
    except Exception:
        return "optional_unavailable"


async def _health_guide_llm_async() -> str:
    try:
        from app.guide.llm_client import CONNECTION_503_BUSY, check_connection as guide_llm_check
        ok, msg = await guide_llm_check()
        if ok:
            return "degraded (503)" if msg == CONNECTION_503_BUSY else "ok"
        if msg == "not_configured":
            return "not_configured"
        if msg == "503":
            return "unavailable (503)"
        if msg == "502":
            return "unavailable (502)"
        if msg in ("connection_refused", "timeout"):
            return msg
        return f"error: {msg}" if msg else "error: unknown"
    except Exception as e:
        return f"error: {e!s}"


@router.get("/health")
async def admin_health() -> dict:
    """管理端用健康与依赖状态（数据库、Redis、引导 LLM 等）。三项并行检查，避免阻塞与长时间等待。"""
    status = {"database": "unknown", "redis": "unknown", "guide_llm": "unknown"}
    # 并行执行：数据库（async）、Redis（线程+3s 超时）、引导 LLM（async，内部 15s 超时）
    async def redis_check() -> str:
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(_health_redis_sync), timeout=3.0
            )
        except asyncio.TimeoutError:
            return "timeout"
        except Exception:
            return "optional_unavailable"
    db_task = asyncio.create_task(_health_database_async())
    redis_task = asyncio.create_task(redis_check())
    llm_task = asyncio.create_task(_health_guide_llm_async())
    status["database"], status["redis"], status["guide_llm"] = await asyncio.gather(
        db_task, redis_task, llm_task
    )
    return {"status": "success", "data": status}

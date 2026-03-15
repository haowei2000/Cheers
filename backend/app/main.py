"""FastAPI 应用入口."""
import logging
import os
import time

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.chat_core import bots as chat_core_bots
from app.chat_core import channels as chat_core_channels
from app.chat_core import context_api as chat_core_context
from app.chat_core import friends as chat_core_friends
from app.chat_core import mcp_import as chat_core_mcp
from app.chat_core import messages as chat_core_messages
from app.chat_core import tasks_api as chat_core_tasks
from app.chat_core import workspaces as chat_core_workspaces
from app.chat_core.ws_manager import ws_manager
from app.admin.routes import router as admin_router
from app.admin.models import router as admin_models_router
from app.admin.templates import router as admin_templates_router
from app.auth.routes import router as auth_router
from app.file_processor import routes as file_routes
from app.logging_config import setup_logging
from app.manual_routes import router as manual_router
from app.db.session import init_db
from app.memory.context_store import init_context_db
from app.public_routes import router as public_router

logger = logging.getLogger("app.main")

app = FastAPI(
    title="AgentNexus",
    description="智枢人机协作平台 API",
    version="0.1.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_requests_for_debug(request: Request, call_next):
    """记录 /api 请求便于排错，404 等错误写入 error.log."""
    path = request.url.path
    if not path.startswith("/api"):
        return await call_next(request)
    start = time.perf_counter()
    response = await call_next(request)
    elapsed = (time.perf_counter() - start) * 1000
    msg = "api %s %s -> %d (%.0fms)" % (request.method, path, response.status_code, elapsed)
    if response.status_code >= 400:
        logger.error("请求失败 %s", msg)
    else:
        logger.info(msg)
    return response


@app.exception_handler(ConnectionRefusedError)
async def database_connection_refused(
    _request, exc: ConnectionRefusedError
) -> JSONResponse:
    """数据库不可达时返回 503."""
    logger.error("database unavailable: %s", exc)
    return JSONResponse(
        status_code=503,
        content={
            "status": "error",
            "message": "database unavailable",
            "data": None,
        },
    )


@app.exception_handler(Exception)
async def unhandled_exception(request, exc: Exception) -> JSONResponse:
    """未捕获异常：记录完整堆栈到日志并返回 500."""
    logger.exception(
        "unhandled exception: %s path=%s %s",
        exc,
        request.method,
        request.url.path,
    )
    return JSONResponse(
        status_code=500,
        content={
            "status": "error",
            "message": "internal server error",
            "data": None,
        },
    )


app.include_router(chat_core_workspaces.router)
app.include_router(chat_core_bots.router)
app.include_router(chat_core_channels.router)
app.include_router(chat_core_messages.router)
app.include_router(chat_core_context.router)
app.include_router(chat_core_tasks.router)
app.include_router(chat_core_mcp.router)
app.include_router(chat_core_friends.router)
app.include_router(admin_router)
app.include_router(admin_models_router)
app.include_router(admin_templates_router)
app.include_router(file_routes.router)
app.include_router(manual_router)
app.include_router(public_router)
app.include_router(auth_router)


@app.websocket("/ws/channels/{channel_id}")
async def websocket_channel(websocket: WebSocket, channel_id: str) -> None:
    """连接频道 WebSocket，接收实时消息推送."""
    await ws_manager.connect(websocket, channel_id)
    try:
        while True:
            data = await websocket.receive_text()
            try:
                obj = {"type": "echo", "data": data}
                await ws_manager.broadcast_to_channel(channel_id, obj)
            except Exception as e:
                logger.warning("ws broadcast channel=%s: %s", channel_id, e)
    except WebSocketDisconnect:
        pass
    finally:
        ws_manager.disconnect(websocket, channel_id)


@app.on_event("startup")
async def startup() -> None:
    """启动时配置日志与 Context Store；可选执行种子数据."""
    setup_logging()
    logger.info("AgentNexus startup")
    await init_db()

    from pathlib import Path
    from app.config import settings
    p = Path(settings.sqlite_context_path)
    if not p.is_absolute():
        p = Path(__file__).resolve().parent.parent.parent / p
    await init_context_db(str(p))

    if os.environ.get("SEED_DATA", "").strip().lower() in ("1", "true", "yes"):
        try:
            from app.db.seed import run_seed
            await run_seed()
        except Exception as e:
            logger.exception("seed data failed: %s", e)

    try:
        from app.admin.settings_store import ensure_preset_llm_providers
        ensure_preset_llm_providers()
    except Exception as e:
        logger.exception("preset LLM providers: %s", e)

    try:
        from app.db.seed import ensure_builtin_bot
        await ensure_builtin_bot()
    except Exception as e:
        logger.exception("ensure builtin bot failed: %s", e)


@app.get("/health")
def health():
    """健康检查."""
    return {"status": "ok"}


@app.post("/api/debug/client-error")
async def log_client_error(request: Request) -> dict:
    """前端上报错误信息，便于排错（不落库，仅写日志）。"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    logger.error(
        "前端上报错误: method=%s url=%s status=%s detail=%s",
        body.get("method", ""),
        body.get("url", ""),
        body.get("status", ""),
        body.get("detail", ""),
        extra={"client_error": body},
    )
    return {"status": "ok"}

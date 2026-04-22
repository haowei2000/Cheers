"""FastAPI 应用入口."""
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.v1.openclaw_bridge.routes import ws_router as openclaw_bridge_ws_router
from app.api.v1.router import v1_router
from app.api.v1.ws.handler import router as ws_router
from app.config import settings
from app.core.exceptions import AppError
from app.core.middleware import AccessLogMiddleware, RequestIDMiddleware
from app.logging_config import setup_logging
from app.manual_routes import router as manual_router
from app.public_routes import router as public_router
from app.services.storage.bootstrap import initialize_storage, is_storage_enabled

logger = logging.getLogger("app.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """管理应用生命周期：启动初始化 & 关闭清理."""
    setup_logging()
    logger.info("AgentNexus startup")

    if not (settings.jwt_secret_key or "").strip():
        logger.warning(
            "JWT_SECRET_KEY 未配置，将使用进程内随机密钥（重启后旧 token 全部失效）。"
            "建议在 .env 中设置 JWT_SECRET_KEY=<随机长字符串>。"
        )

    from app.http_client import init_http_client
    await init_http_client()

    if is_storage_enabled():
        app.state.storage = await initialize_storage()
    else:
        app.state.storage = None

    if os.environ.get("SEED_DATA", "").strip().lower() in ("1", "true", "yes"):
        try:
            from app.db.seed import run_seed
            await run_seed()
        except Exception as e:
            logger.exception("seed data failed: %s", e)

    try:
        from app.db.seed import ensure_builtin_bot
        await ensure_builtin_bot()
    except Exception as e:
        logger.exception("ensure builtin bot failed: %s", e)

    yield

    from app.http_client import close_http_client
    await close_http_client()


app = FastAPI(
    title="AgentNexus",
    description="智枢人机协作平台 API",
    version="0.1.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(AccessLogMiddleware)
app.add_middleware(RequestIDMiddleware)


@app.exception_handler(AppError)
async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    logger.info(
        "app_error code=%s status=%d path=%s %s: %s",
        exc.code, exc.status_code, request.url.path, request.method, exc.message,
    )
    return JSONResponse(
        status_code=exc.status_code,
        content={"status": "error", "message": exc.message, "detail": exc.message, "code": exc.code, "data": None},
    )


@app.exception_handler(ConnectionRefusedError)
async def database_connection_refused(_request, exc: ConnectionRefusedError) -> JSONResponse:
    logger.error("database unavailable: %s", exc)
    return JSONResponse(
        status_code=503,
        content={"status": "error", "message": "database unavailable", "detail": "database unavailable", "data": None},
    )


@app.exception_handler(Exception)
async def unhandled_exception(request, exc: Exception) -> JSONResponse:
    logger.exception("unhandled exception: %s path=%s %s", exc, request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"status": "error", "message": "internal server error", "detail": "internal server error", "data": None},
    )


# v1 架构路由（/api/v1/...）
app.include_router(v1_router)

# WebSocket 路由（/ws/channels/{id}，nginx location /ws 需要 upgrade 头）
app.include_router(ws_router)
app.include_router(openclaw_bridge_ws_router)

# 静态功能路由（不含业务逻辑，保持不变）
app.include_router(manual_router)
app.include_router(public_router)


@app.get("/health")
@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/debug/client-error")
async def log_client_error(request: Request) -> dict:
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

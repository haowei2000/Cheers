"""FastAPI application entrypoint."""
import asyncio
import logging
import os
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.agent_bridge_docs_routes import router as agent_bridge_docs_router
from app.api.v1.agent_bridge.routes import ws_router as agent_bridge_ws_router
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

_file_retention_task: asyncio.Task | None = None


async def _run_file_retention_cleanup_once() -> int:
    from app.db.session import async_session_factory
    from app.services.file_retention import FileRetentionService

    async with async_session_factory() as session:
        count = await FileRetentionService(session).prune_expired_files()
        await session.commit()
        return count


async def _file_retention_cleanup_loop() -> None:
    interval = max(
        3600,
        int(getattr(settings, "file_retention_cleanup_interval_seconds", 24 * 60 * 60) or 24 * 60 * 60),
    )
    while True:
        await asyncio.sleep(interval)
        try:
            count = await _run_file_retention_cleanup_once()
            if count:
                logger.info("file retention cleanup pruned %d expired files", count)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("file retention cleanup failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle startup initialization and shutdown cleanup."""
    global _file_retention_task
    setup_logging()
    logger.info("AgentNexus startup")

    if not (settings.jwt_secret_key or "").strip():
        logger.warning(
            "JWT_SECRET_KEY is not configured; an in-process random secret will be used "
            "and existing tokens will become invalid after restart. Set JWT_SECRET_KEY "
            "to a long random string in .env."
        )

    from app.http_client import init_http_client
    await init_http_client()

    from app.services.realtime_broker import init_realtime_broker
    await init_realtime_broker()

    from app.features.bot_runtime.pipeline.bot.jobs import run_bot_pipeline_job
    from app.features.bot_runtime.pipeline.bot.queue import start_bot_pipeline_workers
    await start_bot_pipeline_workers(run_bot_pipeline_job)

    from app.features.bot_runtime.bot_events.jobs import run_bot_event_job
    from app.features.bot_runtime.bot_events.queue import start_bot_event_workers
    await start_bot_event_workers(run_bot_event_job)

    if is_storage_enabled():
        app.state.storage = await initialize_storage()
    else:
        app.state.storage = None

    try:
        count = await _run_file_retention_cleanup_once()
        if count:
            logger.info("file retention cleanup pruned %d expired files on startup", count)
    except Exception:
        logger.exception("file retention startup cleanup failed")

    try:
        from app.db.session import async_session_factory
        from app.features.bot_runtime.pipeline.bot.task_timeout import recover_agent_bridge_task_timeouts_once

        async with async_session_factory() as session:
            count = await recover_agent_bridge_task_timeouts_once(session)
            if count:
                logger.info("agent bridge timeout recovery converted %d stale tasks", count)
    except Exception:
        logger.exception("agent bridge timeout recovery failed")

    if int(getattr(settings, "file_retention_cleanup_interval_seconds", 24 * 60 * 60) or 0) > 0:
        _file_retention_task = asyncio.create_task(_file_retention_cleanup_loop())

    if os.environ.get("SEED_DATA", "").strip().lower() in ("1", "true", "yes"):
        try:
            from app.db.seed import run_seed
            await run_seed()
        except RuntimeError as e:
            logger.exception("seed data failed: %s", e)
            raise
        except Exception as e:
            logger.exception("seed data failed: %s", e)

    try:
        from app.db.seed import ensure_builtin_bot
        await ensure_builtin_bot()
    except Exception as e:
        logger.exception("ensure builtin bot failed: %s", e)

    yield

    if _file_retention_task is not None:
        _file_retention_task.cancel()
        with suppress(asyncio.CancelledError):
            await _file_retention_task
        _file_retention_task = None

    from app.features.bot_runtime.pipeline.bot.queue import stop_bot_pipeline_workers
    await stop_bot_pipeline_workers()

    from app.features.bot_runtime.bot_events.queue import stop_bot_event_workers
    await stop_bot_event_workers()

    from app.services.realtime_broker import close_realtime_broker
    await close_realtime_broker()

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


# v1 architecture routes (/api/v1/...).
app.include_router(v1_router)

# WebSocket routes (/ws/channels/{id}); nginx location /ws needs upgrade headers.
app.include_router(ws_router)
app.include_router(agent_bridge_ws_router)

# Static feature routes without business logic.
app.include_router(manual_router)
app.include_router(public_router)
app.include_router(agent_bridge_docs_router)


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

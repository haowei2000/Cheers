"""请求 ID 注入 + 访问日志中间件."""
import logging
import time
from uuid import uuid4

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger("app.access")


class RequestIDMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        request_id = str(uuid4())
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response


class AccessLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        path = request.url.path
        if not path.startswith("/api"):
            return await call_next(request)
        start = time.perf_counter()
        response = await call_next(request)
        elapsed = (time.perf_counter() - start) * 1000
        request_id = getattr(request.state, "request_id", "-")
        msg = "api %s %s -> %d (%.0fms) rid=%s" % (
            request.method,
            path,
            response.status_code,
            elapsed,
            request_id,
        )
        if response.status_code >= 400:
            logger.error("请求失败 %s", msg)
        else:
            logger.info(msg)
        return response

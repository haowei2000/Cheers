"""SkillHub FastAPI 主入口"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.api.v1.skillhub.routes import router as skillhub_router

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("skillhub")

# 最大上传文件大小：50MB
MAX_UPLOAD_SIZE = 50 * 1024 * 1024


async def upload_size_middleware(request: Request, call_next):
    """限制请求体大小，防止大文件上传耗尽磁盘"""
    if request.method == "POST" and "multipart/form-data" in request.headers.get("content-type", ""):
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > MAX_UPLOAD_SIZE:
            return JSONResponse(
                status_code=413,
                content={"detail": f"文件过大，最大支持 {MAX_UPLOAD_SIZE // (1024*1024)}MB"}
            )
    return await call_next(request)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用启动/关闭事件"""
    logger.info(f"SkillHub starting on {settings.host}:{settings.port}")
    logger.info(f"Skills directory: {settings.skills_local_dir}")
    yield
    logger.info("SkillHub shutting down")


app = FastAPI(
    title="SkillHub",
    description="AgentNexus SkillHub - Skill 管理与分发平台",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS - 支持所有本地端口
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:[0-9]+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 上传大小限制中间件
app.middleware("http")(upload_size_middleware)

# 注册路由
app.include_router(skillhub_router)


@app.get("/")
async def root():
    """根路径"""
    return {
        "name": "SkillHub",
        "version": "1.0.0",
        "docs": "/docs",
        "api": "/api/v1/skillhub",
    }


@app.get("/health")
async def health():
    """健康检查"""
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=settings.host, port=settings.port)

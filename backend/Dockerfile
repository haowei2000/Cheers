FROM python:3.13-slim
WORKDIR /app

# 安装 uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# 先复制依赖文件，利用 Docker 层缓存
COPY pyproject.toml uv.lock ./

# 使用 uv sync 安装生产依赖（跳过 dev）
RUN uv sync --frozen --no-dev

COPY . .
ENV PYTHONPATH=/app
RUN chmod +x /app/entrypoint.sh
EXPOSE 8000
ENTRYPOINT ["/app/entrypoint.sh"]

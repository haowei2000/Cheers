FROM python:3.13-slim
WORKDIR /app

# 生产镜像只安装运行时依赖，避免 dev 依赖和 lock 中的镜像源导致构建失败。
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ARG PIP_INDEX_URL=https://pypi.org/simple
ENV PIP_INDEX_URL=${PIP_INDEX_URL}

# 先复制生产依赖清单，利用 Docker 层缓存。
COPY requirements-prod.txt ./
RUN python -m pip install --upgrade pip \
    && python -m pip install -r requirements-prod.txt

COPY . .
ENV PYTHONPATH=/app
RUN sed -i 's/\r$//' /app/entrypoint.sh \
    && chmod +x /app/entrypoint.sh
EXPOSE 8000
ENTRYPOINT ["/app/entrypoint.sh"]

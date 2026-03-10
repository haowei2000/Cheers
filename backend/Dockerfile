FROM python:3.12-slim
WORKDIR /app

# 安装 uv（使用清华 PyPI 镜像加速）
RUN pip install uv --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple

# 先复制依赖文件，利用 Docker 层缓存
COPY requirements.txt ./

# 使用 uv + 清华镜像安装依赖
RUN uv pip install --system --no-cache -r requirements.txt \
    --index-url https://pypi.tuna.tsinghua.edu.cn/simple

COPY . .
ENV PYTHONPATH=/app
RUN chmod +x /app/entrypoint.sh
EXPOSE 8000
ENTRYPOINT ["/app/entrypoint.sh"]

FROM docker.m.daocloud.io/library/python:3.13-slim
WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Install uv.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
ENV UV_NO_CACHE=1
#ENV UV_COMPILE_BYTECODE=1

# Copy dependency manifests first to reuse Docker layer cache.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY . .
ENV PYTHONPATH=/app
ENV PATH="/app/.venv/bin:$PATH"
RUN sed -i 's/\r$//' /app/entrypoint.sh \
    && chmod +x /app/entrypoint.sh
EXPOSE 8000
ENTRYPOINT ["/app/entrypoint.sh"]

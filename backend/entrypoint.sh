#!/bin/sh
set -e

cd /app

# Run pending migrations
uv run alembic upgrade head 2>/dev/null || true

# Start the application
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000

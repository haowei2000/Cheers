#!/bin/sh
set -e

cd /app

# Run pending migrations
python -m alembic upgrade head 2>/dev/null || true

# Start the application
exec python -m uvicorn app.main:app --host 0.0.0.0 --port 8000

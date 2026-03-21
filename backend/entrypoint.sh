#!/bin/sh
set -e

cd /app

echo "Running main DB migrations..."
python -m alembic upgrade head

echo "Running context store migrations..."
python -m alembic -c alembic_context.ini upgrade head

echo "Starting server..."
exec python -m uvicorn app.main:app --host 0.0.0.0 --port 8000

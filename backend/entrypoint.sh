#!/bin/sh
set -e

# Ensure we're in the right directory
cd /app

# Add local bin to PATH in case uvicorn was installed there
export PATH="/app/.venv/bin:$PATH"

# Install the package and its dependencies if they're missing
if ! command -v uvicorn >/dev/null 2>&1; then
    echo "uvicorn not found, installing dependencies..."
    pip install --upgrade pip
    pip install -e .
fi

# Run pending migrations
if [ -d alembic ]; then
  alembic upgrade head 2>/dev/null || true
fi

# Start the application
exec uvicorn app.main:app --host 0.0.0.0 --port 8000

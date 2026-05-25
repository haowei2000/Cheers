#!/bin/sh
set -e

cd /app

ALEMBIC_BIN="${ALEMBIC_BIN:-/app/.venv/bin/alembic}"
PYTHON_BIN="${PYTHON_BIN:-/app/.venv/bin/python}"

if [ ! -x "$ALEMBIC_BIN" ]; then
  echo "Alembic executable not found or not executable: ${ALEMBIC_BIN}" >&2
  exit 69
fi

if [ ! -x "$PYTHON_BIN" ]; then
  echo "Python executable not found or not executable: ${PYTHON_BIN}" >&2
  exit 69
fi

is_true() {
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

run_migration() {
  label="$1"
  config="$2"
  mode="${3:-upgrade}"
  target="${4:-head}"

  case "$mode" in
    upgrade)
      echo "Running ${label} migrations: upgrade ${target}"
      "$ALEMBIC_BIN" -c "$config" upgrade "$target"
      ;;
    downgrade)
      if ! is_true "${ALLOW_DB_DOWNGRADE:-0}"; then
        echo "Refusing to downgrade ${label}: set ALLOW_DB_DOWNGRADE=1 to acknowledge rollback risk." >&2
        exit 64
      fi
      if [ -z "$target" ] || [ "$target" = "head" ]; then
        echo "Refusing to downgrade ${label}: migration target must be an explicit revision." >&2
        exit 64
      fi
      echo "Running ${label} migrations: downgrade ${target}"
      "$ALEMBIC_BIN" -c "$config" downgrade "$target"
      ;;
    none|skip|off|false|0)
      echo "Skipping ${label} migrations"
      ;;
    *)
      echo "Unsupported ${label} migration mode: ${mode}. Use upgrade, downgrade, or none." >&2
      exit 64
      ;;
  esac
}

DB_MIGRATION_MODE="${DB_MIGRATION_MODE:-upgrade}"
DB_MIGRATION_TARGET="${DB_MIGRATION_TARGET:-head}"

if [ -z "${CONTEXT_DB_MIGRATION_MODE+x}" ]; then
  if [ "$DB_MIGRATION_MODE" = "downgrade" ]; then
    CONTEXT_DB_MIGRATION_MODE="none"
  else
    CONTEXT_DB_MIGRATION_MODE="upgrade"
  fi
fi
CONTEXT_DB_MIGRATION_TARGET="${CONTEXT_DB_MIGRATION_TARGET:-head}"

run_migration "main DB" "alembic.ini" "$DB_MIGRATION_MODE" "$DB_MIGRATION_TARGET"
run_migration "context store" "alembic_context.ini" "$CONTEXT_DB_MIGRATION_MODE" "$CONTEXT_DB_MIGRATION_TARGET"

if is_true "${MIGRATE_ONLY:-0}"; then
  echo "Migration-only mode complete."
  exit 0
fi

echo "Starting server..."
exec "$PYTHON_BIN" -m uvicorn app.main:app --host 0.0.0.0 --port 8000

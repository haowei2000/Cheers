#!/bin/sh
set -eu

repo_root=$(git rev-parse --show-toplevel)
worktree_name=$(basename "$repo_root" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '_' | sed 's/^_*//;s/_*$//')
worktree_name=${worktree_name:-worktree}
database_name="db_${worktree_name}"
port=${DEV_GATEWAY_PORT:-$(printf '%s' "$worktree_name" | cksum | awk '{ print 18080 + ($1 % 1000) }')}
vite_port=${DEV_VITE_PORT:-$(printf '%s' "$worktree_name" | cksum | awk '{ print 5173 + ($1 % 1000) }')}
cors_origins="http://localhost:${vite_port},http://127.0.0.1:${vite_port}"
vite_api_proxy_target="http://127.0.0.1:${port}"
vite_ws_proxy_target="ws://127.0.0.1:${port}"

case "${1:-env}" in
  env)
    printf 'DATABASE_URL=postgresql://%s:%s@127.0.0.1:%s/%s\n' \
      "${DEV_INFRA_POSTGRES_USER:-cheers}" \
      "${DEV_INFRA_POSTGRES_PASSWORD:-cheers}" \
      "${DEV_INFRA_POSTGRES_PORT:-15432}" "$database_name"
    printf 'REDIS_URL=redis://127.0.0.1:%s/0\n' "${DEV_INFRA_REDIS_PORT:-16379}"
    printf 'S3_ENDPOINT=http://127.0.0.1:%s\n' "${DEV_INFRA_S3_PORT:-19000}"
    printf 'S3_BUCKET=%s\n' "$worktree_name"
    printf 'STORAGE_S3_ACCESS_KEY=%s\n' "${DEV_INFRA_S3_ACCESS_KEY:-cheers-local-access-key}"
    printf 'STORAGE_S3_SECRET_KEY=%s\n' "${DEV_INFRA_S3_SECRET_KEY:-cheers-local-secret-key}"
    printf 'GATEWAY_PORT=%s\n' "$port"
    printf 'VITE_PORT=%s\n' "$vite_port"
    printf 'CORS_ALLOWED_ORIGINS=%s\n' "$cors_origins"
    printf 'VITE_API_PROXY_TARGET=%s\n' "$vite_api_proxy_target"
    printf 'VITE_WS_PROXY_TARGET=%s\n' "$vite_ws_proxy_target"
    ;;
  export)
    printf 'export DATABASE_URL=%s\n' "postgresql://${DEV_INFRA_POSTGRES_USER:-cheers}:${DEV_INFRA_POSTGRES_PASSWORD:-cheers}@127.0.0.1:${DEV_INFRA_POSTGRES_PORT:-15432}/${database_name}"
    printf 'export REDIS_URL=%s\n' "redis://127.0.0.1:${DEV_INFRA_REDIS_PORT:-16379}/0"
    printf 'export S3_ENDPOINT=%s\n' "http://127.0.0.1:${DEV_INFRA_S3_PORT:-19000}"
    printf 'export S3_BUCKET=%s\n' "$worktree_name"
    printf 'export STORAGE_S3_ACCESS_KEY=%s\n' "${DEV_INFRA_S3_ACCESS_KEY:-cheers-local-access-key}"
    printf 'export STORAGE_S3_SECRET_KEY=%s\n' "${DEV_INFRA_S3_SECRET_KEY:-cheers-local-secret-key}"
    printf 'export GATEWAY_PORT=%s\n' "$port"
    printf 'export VITE_PORT=%s\n' "$vite_port"
    printf 'export CORS_ALLOWED_ORIGINS=%s\n' "$cors_origins"
    printf 'export VITE_API_PROXY_TARGET=%s\n' "$vite_api_proxy_target"
    printf 'export VITE_WS_PROXY_TARGET=%s\n' "$vite_ws_proxy_target"
    ;;
  db)
    : "${DEV_INFRA_POSTGRES_USER:=cheers}"
    docker compose -p cheers-dev-infra -f "$repo_root/docker-compose.dev-infra.yml" \
      exec -T postgres sh -ec '
        db="$1"
        if ! psql -U "$POSTGRES_USER" -d postgres -tAc \
          "SELECT 1 FROM pg_database WHERE datname = '\''$db'\''" | grep -q 1; then
          createdb -U "$POSTGRES_USER" "$db"
        fi
      ' sh "$database_name"
    ;;
  *)
    echo "Usage: $0 [env|export|db]" >&2
    exit 2
    ;;
esac

#!/usr/bin/env bash
set -euo pipefail

# DATABASE_URL must point to a disposable database, never production.
# CI supplies a fresh Postgres service; local setup is documented in
# server/SQLX_OFFLINE.md. No existing migration body is changed here.
mode="${1:-prepare}"
case "$mode" in
  prepare|check) ;;
  *) echo "Usage: $0 [prepare|check]" >&2; exit 2 ;;
esac
: "${DATABASE_URL:?Set DATABASE_URL to a disposable PostgreSQL database}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root/server"
# The default Cargo configuration is offline. Preparing metadata must inspect
# the live schema even when the caller inherited SQLX_OFFLINE=true.
export SQLX_OFFLINE=false
cargo sqlx migrate run
if [[ "$mode" == check ]]; then
  cargo sqlx prepare --check -- --all-targets --features integration
else
  cargo sqlx prepare -- --all-targets --features integration
fi

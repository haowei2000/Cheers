#!/usr/bin/env bash
# Run the gateway from source with dev JWT keys injected from PEM files.
# The remaining config is read from server/.env by dotenvy.
set -euo pipefail
cd "$(dirname "$0")/.."
export JWT_PRIVATE_KEY="$(cat .dev/jwt_private.pem)"
export JWT_PUBLIC_KEY="$(cat .dev/jwt_public.pem)"
exec cargo run "$@"

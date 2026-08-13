#!/usr/bin/env bash
set -euo pipefail

# End-to-end MCP 2026-07-28 gate. This deliberately obtains the MCP bearer via
# the public installation enrollment + OAuth client_credentials flow; it never
# inserts a Bot credential or bypasses the protected-resource boundary.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gateway_port="${CHEERS_MCP_GATEWAY_PORT:-38080}"
proxy_port="${CHEERS_MCP_PROXY_PORT:-39091}"
gateway_origin="http://127.0.0.1:${gateway_port}"
proxy_origin="http://127.0.0.1:${proxy_port}"
tmp_dir="$(mktemp -d)"
gateway_pid=""
proxy_pid=""

cleanup() {
  local exit_code=$?
  set +e
  if [[ "$exit_code" -ne 0 ]]; then
    for log_file in "$tmp_dir/gateway.log" "$tmp_dir/proxy.log"; do
      if [[ -s "$log_file" ]]; then
        echo "--- $(basename "$log_file") (last 200 lines) ---" >&2
        tail -n 200 "$log_file" >&2
      fi
    done
  fi
  if [[ -n "$proxy_pid" ]]; then
    kill "$proxy_pid" 2>/dev/null || true
    wait "$proxy_pid" 2>/dev/null || true
  fi
  if [[ -n "$gateway_pid" ]]; then
    kill "$gateway_pid" 2>/dev/null || true
    wait "$gateway_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
  trap - EXIT
  exit "$exit_code"
}
trap cleanup EXIT

wait_for_http() {
  local label=$1
  local url=$2
  local pid=$3
  local timeout_seconds=$4
  local deadline=$((SECONDS + timeout_seconds))

  while ((SECONDS < deadline)); do
    # Any HTTP response proves the listener is ready. Callers use a dedicated
    # health URL where a successful status is also required by the next step.
    if curl -sS --connect-timeout 1 -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$label exited before becoming ready" >&2
      return 1
    fi
    sleep 1
  done

  echo "$label did not become ready within ${timeout_seconds}s" >&2
  return 1
}

: "${DATABASE_URL:?DATABASE_URL is required}"
command -v curl >/dev/null
command -v jq >/dev/null
command -v openssl >/dev/null
command -v npx >/dev/null

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out "$tmp_dir/private.pem" >/dev/null 2>&1
openssl rsa -pubout -in "$tmp_dir/private.pem" -out "$tmp_dir/public.pem" \
  >/dev/null 2>&1

export JWT_PRIVATE_KEY="$(<"$tmp_dir/private.pem")"
export JWT_PUBLIC_KEY="$(<"$tmp_dir/public.pem")"
admin_username="${MCP_CONFORMANCE_ADMIN_USERNAME:-mcp-conformance}"
admin_password="${MCP_CONFORMANCE_ADMIN_PASSWORD:-mcp-conformance-only}"
run_suffix="$(openssl rand -hex 6)"
export ADMIN_USERNAME="$admin_username"
export ADMIN_PASSWORD="$admin_password"
export REQUIRE_2FA_FOR_REMOTE_AGENT_ACCESS=false
export PORT="$gateway_port"
export MCP_PUBLIC_URL="${gateway_origin}/mcp"
export CORS_ALLOWED_ORIGINS="$proxy_origin"
export CHEERS_MCP_CONFORMANCE_FIXTURES=1
export S3_ENDPOINT="http://127.0.0.1:59999"
export S3_BUCKET="mcp-conformance-unused"
export S3_ACCESS_KEY="unused"
export S3_SECRET_KEY="unused"
export S3_REGION="us-east-1"

cargo build --manifest-path "$repo_root/server/Cargo.toml" --bin server
target_dir="$(cargo metadata --manifest-path "$repo_root/server/Cargo.toml" \
  --format-version 1 --no-deps | jq -er .target_directory)"
"$target_dir/debug/server" \
  >"$tmp_dir/gateway.log" 2>&1 &
gateway_pid=$!

wait_for_http "Cheers gateway" "${gateway_origin}/health" "$gateway_pid" \
  "${CHEERS_MCP_STARTUP_TIMEOUT_SECONDS:-120}"
curl -fsS "${gateway_origin}/health" >/dev/null

admin_token="$(curl -fsS -X POST "${gateway_origin}/api/v1/auth/login" \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg login "$admin_username" --arg password "$admin_password" '{login:$login,password:$password}')" | jq -er .access_token)"

bot_id="$(curl -fsS -X POST "${gateway_origin}/api/v1/bots" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer ${admin_token}" \
  --data "$(jq -nc --arg username "mcp-conformance-${run_suffix}" '{username:$username,display_name:"MCP Conformance Agent",binding_type:"agent_bridge",bridge_provider:"generic"}')" \
  | jq -er .bot_id)"

enrollment="$(curl -fsS -X POST "${gateway_origin}/api/v1/bots/${bot_id}/enrollment" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer ${admin_token}" \
  --data '{"agent_type":"generic","device_name":"official-conformance"}')"
code="$(jq -er .code <<<"$enrollment")"

installation="$(curl -fsS -X POST "${gateway_origin}/api/v1/enrollment/redeem" \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg code "$code" '{code:$code,device_name:"official-conformance"}')")"
installation_id="$(jq -er .installation_id <<<"$installation")"
credential="$(jq -er .credential <<<"$installation")"

oauth="$(curl -fsS -u "${installation_id}:${credential}" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=client_credentials \
  --data-urlencode "resource=${gateway_origin}/mcp" \
  "${gateway_origin}/oauth/token")"
access_token="$(jq -er .access_token <<<"$oauth")"

CHEERS_MCP_TARGET="${gateway_origin}/mcp" \
CHEERS_MCP_ACCESS_TOKEN="$access_token" \
CHEERS_MCP_PROXY_PORT="$proxy_port" \
node "$repo_root/scripts/mcp-conformance-auth-proxy.mjs" \
  >"$tmp_dir/proxy.log" 2>&1 &
proxy_pid=$!

wait_for_http "MCP auth proxy" "${proxy_origin}/mcp" "$proxy_pid" \
  "${CHEERS_MCP_PROXY_TIMEOUT_SECONDS:-20}"

npx -y @modelcontextprotocol/conformance@0.2.0-alpha.11 server \
  --url "${proxy_origin}/mcp" \
  --suite all \
  --spec-version 2026-07-28

# The access token is not merely JWT-valid: each request rechecks the live
# installation + current credential hash. Revocation must therefore invalidate
# an already-issued token immediately, before its ten-minute expiry.
discover_body='{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
curl -fsS "${gateway_origin}/mcp" \
  -H "authorization: Bearer ${access_token}" \
  -H 'content-type: application/json' \
  -H 'mcp-protocol-version: 2026-07-28' \
  -H 'mcp-method: server/discover' \
  --data "$discover_body" >/dev/null

curl -fsS -X DELETE "${gateway_origin}/api/v1/bots/${bot_id}/installations/${installation_id}" \
  -H "authorization: Bearer ${admin_token}" >/dev/null

revoked_status="$(curl -sS -o /dev/null -w '%{http_code}' "${gateway_origin}/mcp" \
  -H "authorization: Bearer ${access_token}" \
  -H 'content-type: application/json' \
  -H 'mcp-protocol-version: 2026-07-28' \
  -H 'mcp-method: server/discover' \
  --data "$discover_body")"
if [[ "$revoked_status" != "401" ]]; then
  echo "expected revoked installation MCP token to return 401, got ${revoked_status}" >&2
  exit 1
fi

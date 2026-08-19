#!/usr/bin/env bash
set -euo pipefail

# Run one isolated Agent × OAuth-mode direct HTTP MCP spike case. This script
# creates a disposable PostgreSQL/Gateway/Frontend stack, one Bot host,
# and one channel. It never inserts an Authorization header into McpServerHttp.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
agent=""
mode=""
phase="full"
hold_seconds="620"
keep_artifacts=false
dry_run=false

usage() {
  cat <<'EOF'
Usage: scripts/run-mcp-direct-oauth-spike.sh --agent AGENT --mode MODE [options]

Agents: codex | claude | gemini | opencode
Modes:  interactive | client-credentials
Options:
  --phase capability|provider-auth|session|full  Probe depth (default: full)
  --hold-seconds N                 Wait before the second prompt (default: 620)
  --keep-artifacts                 Keep the redacted result directory
  --dry-run                        Validate inputs and print the case plan only

Environment:
  CHEERS_SPIKE_AGENT_COMMAND_JSON  Optional argv override, e.g. ["codex-acp"]
  CHEERS_SPIKE_AGENT_ENV_JSON      Documented Agent-specific OAuth env template;
                                   values may use {{host_id}} and
                                   {{host_credential}}
  CHEERS_SPIKE_ACCEPT_ELICITATION_URL=1  Accept opening an Agent URL elicitation
  CHEERS_SPIKE_PUBLIC_ORIGIN       Optional browser-reachable frontend origin
  CHEERS_SPIKE_RESULT_ROOT         Redacted evidence root (default: /tmp)

Client credentials are intentionally not mapped to generic environment names.
If an Agent has no documented credential provider, that mode is recorded as
unsupported rather than made to pass with a private shim.
EOF
}

while (($#)); do
  case "$1" in
    --agent) agent="${2:-}"; shift 2 ;;
    --mode) mode="${2:-}"; shift 2 ;;
    --phase) phase="${2:-}"; shift 2 ;;
    --hold-seconds) hold_seconds="${2:-}"; shift 2 ;;
    --keep-artifacts) keep_artifacts=true; shift ;;
    --dry-run) dry_run=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$agent" in codex|claude|gemini|opencode) ;; *) echo "invalid --agent" >&2; exit 2 ;; esac
case "$mode" in interactive|client-credentials) ;; *) echo "invalid --mode" >&2; exit 2 ;; esac
case "$phase" in capability|provider-auth|session|full) ;; *) echo "invalid --phase" >&2; exit 2 ;; esac
[[ "$hold_seconds" =~ ^[0-9]+$ ]] || { echo "--hold-seconds must be an integer" >&2; exit 2; }

if [[ "$mode" == client-credentials && "$phase" != capability && "$phase" != provider-auth && -z "${CHEERS_SPIKE_AGENT_ENV_JSON:-}" ]]; then
  echo "client-credentials requires the Agent's documented credential provider via CHEERS_SPIKE_AGENT_ENV_JSON" >&2
  echo "No generic secret env is injected; absence is an unsupported result, not a harness error." >&2
  exit 3
fi

if $dry_run; then
  jq -cn \
    --arg agent "$agent" --arg mode "$mode" --arg phase "$phase" \
    --argjson hold_seconds "$hold_seconds" \
    '{agent:$agent,mode:$mode,phase:$phase,hold_seconds:$hold_seconds,direct_http:true,static_authorization_header:false}'
  exit 0
fi

if [[ "$phase" == capability || "$phase" == provider-auth ]]; then
  CHEERS_SPIKE_AGENT_ID="$agent" CHEERS_SPIKE_PHASE=capability \
    node "$repo_root/scripts/mcp-direct-oauth-agent-probe.mjs"
  exit $?
fi

for command in docker curl jq openssl node cargo; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 2; }
done

suffix="$(openssl rand -hex 5)"
case_id="${agent}-${mode}-${suffix}"
result_root="${CHEERS_SPIKE_RESULT_ROOT:-/tmp/cheers-mcp-oauth-spike}"
case_dir="${result_root}/${case_id}"
mkdir -p "$case_dir"
chmod 700 "$case_dir"
container="cheers-mcp-spike-${suffix}"
gateway_pid=""
frontend_pid=""

cleanup() {
  local exit_code=$?
  set +e
  [[ -n "$frontend_pid" ]] && kill "$frontend_pid" 2>/dev/null
  [[ -n "$gateway_pid" ]] && kill "$gateway_pid" 2>/dev/null
  docker rm -f "$container" >/dev/null 2>&1
  rm -f "$case_dir/private.pem" "$case_dir/public.pem" "$case_dir/operator.txt"
  for log_file in "$case_dir/gateway.log" "$case_dir/frontend.log"; do
    [[ -f "$log_file" ]] && node "$repo_root/scripts/redact-mcp-oauth-spike-evidence.mjs" "$log_file"
  done
  if ! $keep_artifacts; then
    rm -rf "$case_dir"
  else
    echo "redacted evidence: $case_dir" >&2
  fi
  trap - EXIT
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

# Poll one HTTP endpoint while also detecting premature child exit.
wait_http() {
  local url=$1 pid=$2 deadline=$((SECONDS + 150))
  while ((SECONDS < deadline)); do
    curl -fsS --connect-timeout 1 "$url" >/dev/null 2>&1 && return 0
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

docker run -d --name "$container" \
  -e POSTGRES_USER=cheers -e POSTGRES_PASSWORD=cheers \
  -e POSTGRES_DB="spike_${suffix}" \
  -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
postgres_port="$(docker port "$container" 5432/tcp | awk -F: 'NR==1 {print $NF}')"
for _ in {1..60}; do
  docker exec "$container" pg_isready -U cheers >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$container" pg_isready -U cheers >/dev/null

gateway_port="$((41000 + 0x${suffix:0:3} % 10000))"
frontend_port="$((gateway_port + 1))"
gateway_origin="http://127.0.0.1:${gateway_port}"
frontend_origin="${CHEERS_SPIKE_PUBLIC_ORIGIN:-http://127.0.0.1:${frontend_port}}"
# OAuth redirects and the MCP resource must share the browser-facing origin;
# Vite proxies /mcp and /oauth to the isolated Gateway.
mcp_url="${frontend_origin}/mcp"

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out "$case_dir/private.pem" >/dev/null 2>&1
openssl rsa -pubout -in "$case_dir/private.pem" -out "$case_dir/public.pem" >/dev/null 2>&1

export DATABASE_URL="postgres://cheers:cheers@127.0.0.1:${postgres_port}/spike_${suffix}"
export JWT_PRIVATE_KEY="$(<"$case_dir/private.pem")"
export JWT_PUBLIC_KEY="$(<"$case_dir/public.pem")"
export ADMIN_USERNAME="spike-admin-${suffix}"
export ADMIN_PASSWORD="spike-only-${suffix}"
export REQUIRE_2FA_FOR_REMOTE_AGENT_ACCESS=false
export PORT="$gateway_port"
export MCP_PUBLIC_URL="$mcp_url"
export CORS_ALLOWED_ORIGINS="$frontend_origin"
export S3_ENDPOINT="http://127.0.0.1:59999"
export S3_BUCKET="mcp-spike-unused"
export S3_ACCESS_KEY="unused"
export S3_SECRET_KEY="unused"
export S3_REGION="us-east-1"

cargo build --manifest-path "$repo_root/server/Cargo.toml" --bin server
target_dir="$(cargo metadata --manifest-path "$repo_root/server/Cargo.toml" --format-version 1 --no-deps | jq -er .target_directory)"
"$target_dir/debug/server" >"$case_dir/gateway.log" 2>&1 &
gateway_pid=$!
wait_http "$gateway_origin/health" "$gateway_pid" || { tail -n 100 "$case_dir/gateway.log" >&2; exit 1; }

(
  cd "$repo_root/frontend"
  PORT="$frontend_port" VITE_API_PROXY_TARGET="$gateway_origin" npm run dev -- --host 127.0.0.1 --strictPort
) >"$case_dir/frontend.log" 2>&1 &
frontend_pid=$!
wait_http "$frontend_origin" "$frontend_pid" || { tail -n 100 "$case_dir/frontend.log" >&2; exit 1; }

# Call one authenticated setup endpoint with the isolated admin session.
api_json() {
  local method=$1 path=$2 body=$3
  curl -fsS -X "$method" "$gateway_origin$path" \
    -H 'content-type: application/json' \
    -H "authorization: Bearer ${admin_token}" \
    --data "$body"
}

admin_token="$(curl -fsS -X POST "$gateway_origin/api/v1/auth/login" \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg login "$ADMIN_USERNAME" --arg password "$ADMIN_PASSWORD" '{login:$login,password:$password}')" | jq -er .access_token)"
workspace_id="$(api_json POST /api/v1/workspaces "$(jq -nc --arg name "OAuth spike ${case_id}" '{name:$name}')" | jq -er .workspace_id)"
bot_id="$(api_json POST /api/v1/bots "$(jq -nc --arg username "spike-${case_id}" '{username:$username,display_name:$username,binding_type:"agent_bridge",bridge_provider:"generic"}')" | jq -er .bot_id)"
channel_id="$(api_json POST /api/v1/channels "$(jq -nc --arg workspace_id "$workspace_id" --arg name "spike-${case_id}" --arg bot_id "$bot_id" '{workspace_id:$workspace_id,name:$name,type:"private",initial_bot_ids:[$bot_id]}')" | jq -er .channel_id)"
pairing="$(api_json POST "/api/v1/bots/${bot_id}/hosts" "$(jq -nc --arg agent_type "$agent" --arg device_name "$case_id" '{agent_type:$agent_type,device_name:$device_name}')")"
code="$(jq -er .pairing_code <<<"$pairing")"
host="$(curl -fsS -X POST "$gateway_origin/api/v1/hosts/redeem" \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg code "$code" --arg device_name "$case_id" '{pairing_code:$code,device_name:$device_name}')")"
host_id="$(jq -er .host_id <<<"$host")"
host_credential="$(jq -er .credential <<<"$host")"

if [[ -n "${CHEERS_SPIKE_AGENT_ENV_JSON:-}" ]]; then
  CHEERS_SPIKE_AGENT_ENV_JSON="$(jq -ce \
    --arg host_id "$host_id" \
    --arg host_credential "$host_credential" \
    'walk(if type == "string" then gsub("\\{\\{host_id\\}\\}"; $host_id) | gsub("\\{\\{host_credential\\}\\}"; $host_credential) else . end)' \
    <<<"$CHEERS_SPIKE_AGENT_ENV_JSON")"
  export CHEERS_SPIKE_AGENT_ENV_JSON
fi

if [[ "$mode" == interactive ]]; then
  umask 077
  {
    echo "Temporary Frontend: $frontend_origin"
    echo "Temporary username: $ADMIN_USERNAME"
    echo "Temporary password: $ADMIN_PASSWORD"
    echo "Consent host: $host_id"
  } >"$case_dir/operator.txt"
  echo "interactive operator instructions (deleted during cleanup): $case_dir/operator.txt" >&2
fi

# Harness-only values are stripped by the probe before the Agent is spawned.
export CHEERS_SPIKE_HOST_ID="$host_id"
export CHEERS_SPIKE_HOST_CREDENTIAL="$host_credential"
export CHEERS_SPIKE_ADMIN_TOKEN="$admin_token"
export CHEERS_SPIKE_AGENT_ID="$agent"
export CHEERS_SPIKE_MCP_URL="$mcp_url"
export CHEERS_SPIKE_PHASE="$phase"
export CHEERS_SPIKE_CWD="$repo_root"
export CHEERS_SPIKE_HOLD_MS="$((hold_seconds * 1000))"
export CHEERS_SPIKE_RESULT_FILE="$case_dir/result.json"
export CHEERS_SPIKE_PROMPT="Use the Cheers MCP server only. First call get_channel_info with channel_id ${channel_id}. Then call post_message with channel_id ${channel_id} and text exactly MCP_DIRECT_OAUTH_${case_id}. Do not use shell, curl, filesystem, or any non-MCP workaround."

set +e
node "$repo_root/scripts/mcp-direct-oauth-agent-probe.mjs"
probe_status=$?
set -e

restart_status=99
if [[ "$probe_status" -eq 0 && "$phase" == full ]]; then
  # A fresh ACP process must recover the Agent-owned OAuth state without a
  # second user consent. Keep the second prompt read-only to avoid duplicate
  # write ambiguity in the evidence.
  set +e
  CHEERS_SPIKE_HOLD_MS=0 \
  CHEERS_SPIKE_PROMPT="Use the Cheers MCP server only. Call get_channel_info with channel_id ${channel_id}. Do not use shell, curl, filesystem, or any non-MCP workaround." \
  CHEERS_SPIKE_RESULT_FILE="$case_dir/restart-result.json" \
    node "$repo_root/scripts/mcp-direct-oauth-agent-probe.mjs"
  restart_status=$?
  set -e
fi

# Store only non-secret server-side assertions. SQL runs inside the disposable DB.
posted_count="$(docker exec "$container" psql -U cheers -d "spike_${suffix}" -Atc \
  "SELECT COUNT(*) FROM messages WHERE channel_id='${channel_id}' AND sender_id='${bot_id}' AND sender_type='bot' AND content='MCP_DIRECT_OAUTH_${case_id}'")"
oauth_rows="$(docker exec "$container" psql -U cheers -d "spike_${suffix}" -Atc \
  "SELECT COUNT(*) FROM mcp_oauth_refresh_tokens WHERE host_id='${host_id}'")"
rotated_oauth_rows="$(docker exec "$container" psql -U cheers -d "spike_${suffix}" -Atc \
  "SELECT COUNT(*) FROM mcp_oauth_refresh_tokens WHERE host_id='${host_id}' AND rotated_at IS NOT NULL")"
scope_rows="$(docker exec "$container" psql -U cheers -d "spike_${suffix}" -Atc \
  "SELECT COUNT(*) FROM mcp_oauth_refresh_tokens WHERE host_id='${host_id}' AND scope LIKE '%cheers:read%' AND scope LIKE '%cheers:messages:write%'")"
resource_rows="$(docker exec "$container" psql -U cheers -d "spike_${suffix}" -Atc \
  "SELECT COUNT(*) FROM mcp_oauth_refresh_tokens WHERE host_id='${host_id}' AND resource='${mcp_url}'")"
jq -n --arg case_id "$case_id" --arg agent "$agent" --arg mode "$mode" \
  --arg channel_id "$channel_id" --argjson posted_count "$posted_count" \
  --argjson refresh_token_rows "$oauth_rows" --argjson rotated_refresh_token_rows "$rotated_oauth_rows" --argjson expected_scope_rows "$scope_rows" --argjson expected_resource_rows "$resource_rows" --argjson probe_status "$probe_status" \
  --argjson restart_status "$restart_status" \
  '{case_id:$case_id,agent:$agent,mode:$mode,channel_id:$channel_id,posted_count:$posted_count,refresh_token_rows:$refresh_token_rows,rotated_refresh_token_rows:$rotated_refresh_token_rows,expected_scope_rows:$expected_scope_rows,expected_resource_rows:$expected_resource_rows,probe_status:$probe_status,restart_status:$restart_status}' \
  >"$case_dir/assertions.json"

# Revocation is always exercised. A subsequent full-phase run against the same
# case is intentionally impossible: the host is now invalid.
curl -fsS -X DELETE "$gateway_origin/api/v1/bots/${bot_id}/hosts/${host_id}" \
  -H "authorization: Bearer ${admin_token}" >/dev/null

revoked_token_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$gateway_origin/oauth/token" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "client_id=${host_id}" \
  --data-urlencode "client_secret=${host_credential}" \
  --data-urlencode 'scope=cheers:read' \
  --data-urlencode "resource=${mcp_url}")"
jq --argjson revoked_token_status "$revoked_token_status" '. + {revoked_token_status:$revoked_token_status}' \
  "$case_dir/assertions.json" >"$case_dir/assertions.next.json"
mv "$case_dir/assertions.next.json" "$case_dir/assertions.json"

revoked_status=99
if [[ "$probe_status" -eq 0 && "$phase" == full ]]; then
  set +e
  CHEERS_SPIKE_HOLD_MS=0 \
  CHEERS_SPIKE_PROMPT="Use the Cheers MCP server only. Call get_channel_info with channel_id ${channel_id}. Do not use shell, curl, filesystem, or any non-MCP workaround." \
  CHEERS_SPIKE_RESULT_FILE="$case_dir/revoked-result.json" \
    node "$repo_root/scripts/mcp-direct-oauth-agent-probe.mjs"
  revoked_status=$?
  set -e
  jq --argjson revoked_status "$revoked_status" '. + {revoked_status:$revoked_status}' \
    "$case_dir/assertions.json" >"$case_dir/assertions.next.json"
  mv "$case_dir/assertions.next.json" "$case_dir/assertions.json"
fi

if [[ "$probe_status" -ne 0 || "$revoked_token_status" -ne 401 \
  || ( "$phase" == full && ( "$posted_count" -lt 1 || "$resource_rows" -lt 1 ) ) \
  || ( "$phase" == full && "$mode" == interactive && ( "$rotated_oauth_rows" -lt 1 || "$scope_rows" -lt 1 || "$resource_rows" -lt 1 ) ) \
  || ( "$phase" == full && ( "$restart_status" -ne 0 || "$revoked_status" -eq 0 ) ) ]]; then
  echo "case failed: inspect redacted evidence with --keep-artifacts" >&2
  exit 1
fi
echo "case passed: ${case_id}"

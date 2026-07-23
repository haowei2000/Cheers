#!/usr/bin/env bash
set -euo pipefail

umask 077

readonly DEPLOY_ROOT="/opt/cheers"
readonly ENV_FILE="${DEPLOY_ROOT}/.env"
readonly COMPOSE_FILE="${DEPLOY_ROOT}/docker-compose.yml"
readonly TLS_COMPOSE_FILE="${DEPLOY_ROOT}/docker-compose.production.tls.yml"
readonly PAYLOAD_VERSION="CHEERS_DEPLOY_AUTH_ENV_V1"
readonly MANAGED_BEGIN="# BEGIN CHEERS GITHUB-MANAGED AUTH"
readonly MANAGED_END="# END CHEERS GITHUB-MANAGED AUTH"

PAYLOAD_FILE=""
PRIVATE_KEY_FILE=""
MANAGED_BLOCK_FILE=""
ENV_CANDIDATE=""
ENV_BACKUP=""
ENV_UPDATED="false"

cleanup() {
  rm -f -- \
    "${PAYLOAD_FILE:-}" \
    "${PRIVATE_KEY_FILE:-}" \
    "${MANAGED_BLOCK_FILE:-}" \
    "${ENV_CANDIDATE:-}" \
    "${ENV_BACKUP:-}"
}
trap cleanup EXIT HUP INT TERM

fail() {
  echo "[deploy] rejected authentication configuration: $1" >&2
  exit 1
}

decode_field() {
  local key="$1"
  local encoded="$2"
  local decoded

  [[ "$encoded" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] ||
    fail "invalid encoding for ${key}"
  decoded="$(printf '%s' "$encoded" | base64 --decode 2>/dev/null)" ||
    fail "invalid encoding for ${key}"
  [[ -n "$decoded" ]] || fail "empty value for ${key}"
  printf '%s' "$decoded"
}

sync_auth_environment() {
  local header="$1"
  local line key encoded
  local -A values=()
  local -A seen=()
  local -a required=(
    APPLE_TEAM_ID
    APPLE_KEY_ID
    APPLE_CLIENT_ID
    APPLE_PRIVATE_KEY_P8
    APPLE_WEB_CLIENT_ID
    APPLE_WEB_REDIRECT_URI
    OAUTH_WEB_RETURN_URL
  )

  [[ "$header" == "$PAYLOAD_VERSION" ]] ||
    fail "unsupported payload version"

  PAYLOAD_FILE="$(mktemp "${DEPLOY_ROOT}/.deploy-auth-payload.XXXXXX")"
  cat > "$PAYLOAD_FILE"

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == *=* ]] || fail "malformed payload line"
    key="${line%%=*}"
    encoded="${line#*=}"

    case "$key" in
      APPLE_TEAM_ID | \
        APPLE_KEY_ID | \
        APPLE_CLIENT_ID | \
        APPLE_PRIVATE_KEY_P8 | \
        APPLE_WEB_CLIENT_ID | \
        APPLE_WEB_REDIRECT_URI | \
        GOOGLE_WEB_CLIENT_ID | \
        GOOGLE_WEB_CLIENT_SECRET | \
        GOOGLE_WEB_REDIRECT_URI | \
        OAUTH_WEB_RETURN_URL)
        ;;
      *)
        fail "field is not allowlisted"
        ;;
    esac

    [[ -z "${seen[$key]:-}" ]] || fail "duplicate field"
    seen["$key"]="true"
    values["$key"]="$(decode_field "$key" "$encoded")"
  done < "$PAYLOAD_FILE"

  for key in "${required[@]}"; do
    [[ -n "${values[$key]:-}" ]] || fail "required field is missing"
  done

  local google_count=0
  for key in GOOGLE_WEB_CLIENT_ID GOOGLE_WEB_CLIENT_SECRET GOOGLE_WEB_REDIRECT_URI; do
    if [[ -n "${values[$key]:-}" ]]; then
      google_count=$((google_count + 1))
    fi
  done
  [[ "$google_count" -eq 0 || "$google_count" -eq 3 ]] ||
    fail "Google OAuth fields must be configured together"

  [[ "${values[APPLE_TEAM_ID]}" =~ ^[A-Z0-9]{10}$ ]] ||
    fail "APPLE_TEAM_ID has an invalid format"
  [[ "${values[APPLE_KEY_ID]}" =~ ^[A-Z0-9]{10}$ ]] ||
    fail "APPLE_KEY_ID has an invalid format"
  [[ "${values[APPLE_CLIENT_ID]}" =~ ^[A-Za-z0-9.-]+$ ]] ||
    fail "APPLE_CLIENT_ID has an invalid format"
  [[ "${values[APPLE_WEB_CLIENT_ID]}" =~ ^[A-Za-z0-9.-]+$ ]] ||
    fail "APPLE_WEB_CLIENT_ID has an invalid format"
  [[ "${values[APPLE_WEB_REDIRECT_URI]}" == \
    "https://www.tocheers.com/api/v1/auth/oauth/apple/callback" ]] ||
    fail "APPLE_WEB_REDIRECT_URI is not the production callback"
  [[ "${values[OAUTH_WEB_RETURN_URL]}" == \
    "https://www.tocheers.com/auth/callback" ]] ||
    fail "OAUTH_WEB_RETURN_URL is not the production callback"
  if [[ "$google_count" -eq 3 ]]; then
    [[ "${values[GOOGLE_WEB_CLIENT_ID]}" =~ ^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$ ]] ||
      fail "GOOGLE_WEB_CLIENT_ID has an invalid format"
    [[ "${values[GOOGLE_WEB_REDIRECT_URI]}" == \
      "https://www.tocheers.com/api/v1/auth/oauth/google/callback" ]] ||
      fail "GOOGLE_WEB_REDIRECT_URI is not the production callback"
    [[ "${values[GOOGLE_WEB_CLIENT_SECRET]}" != *"'"* ]] ||
      fail "GOOGLE_WEB_CLIENT_SECRET contains an unsupported character"
    [[ "${values[GOOGLE_WEB_CLIENT_SECRET]}" != *$'\n'* ]] ||
      fail "GOOGLE_WEB_CLIENT_SECRET contains an unsupported newline"
  fi

  PRIVATE_KEY_FILE="$(mktemp "${DEPLOY_ROOT}/.apple-private-key.XXXXXX")"
  printf '%s\n' "${values[APPLE_PRIVATE_KEY_P8]}" > "$PRIVATE_KEY_FILE"
  grep -q '^-----BEGIN PRIVATE KEY-----$' "$PRIVATE_KEY_FILE" ||
    fail "APPLE_PRIVATE_KEY_P8 has an invalid header"
  grep -q '^-----END PRIVATE KEY-----$' "$PRIVATE_KEY_FILE" ||
    fail "APPLE_PRIVATE_KEY_P8 has an invalid footer"
  openssl pkey -in "$PRIVATE_KEY_FILE" -noout -check >/dev/null 2>&1 ||
    fail "APPLE_PRIVATE_KEY_P8 is not a valid private key"
  [[ "${values[APPLE_PRIVATE_KEY_P8]}" != *"'"* ]] ||
    fail "APPLE_PRIVATE_KEY_P8 contains an unsupported character"

  MANAGED_BLOCK_FILE="$(mktemp "${DEPLOY_ROOT}/.managed-auth-env.XXXXXX")"
  {
    printf '%s\n' "$MANAGED_BEGIN"
    printf "APPLE_TEAM_ID='%s'\n" "${values[APPLE_TEAM_ID]}"
    printf "APPLE_KEY_ID='%s'\n" "${values[APPLE_KEY_ID]}"
    printf "APPLE_CLIENT_ID='%s'\n" "${values[APPLE_CLIENT_ID]}"
    printf "APPLE_PRIVATE_KEY_P8='%s'\n" "${values[APPLE_PRIVATE_KEY_P8]}"
    printf "APPLE_WEB_CLIENT_ID='%s'\n" "${values[APPLE_WEB_CLIENT_ID]}"
    printf "APPLE_WEB_REDIRECT_URI='%s'\n" "${values[APPLE_WEB_REDIRECT_URI]}"
    if [[ "$google_count" -eq 3 ]]; then
      printf "GOOGLE_WEB_CLIENT_ID='%s'\n" "${values[GOOGLE_WEB_CLIENT_ID]}"
      printf "GOOGLE_WEB_CLIENT_SECRET='%s'\n" "${values[GOOGLE_WEB_CLIENT_SECRET]}"
      printf "GOOGLE_WEB_REDIRECT_URI='%s'\n" "${values[GOOGLE_WEB_REDIRECT_URI]}"
    fi
    printf "OAUTH_WEB_RETURN_URL='%s'\n" "${values[OAUTH_WEB_RETURN_URL]}"
    printf '%s\n' "$MANAGED_END"
  } > "$MANAGED_BLOCK_FILE"

  ENV_CANDIDATE="$(mktemp "${DEPLOY_ROOT}/.env.candidate.XXXXXX")"
  awk \
    -v begin="$MANAGED_BEGIN" \
    -v end="$MANAGED_END" \
    '
      $0 == begin {
        if (managed) exit 42
        managed = 1
        skipping = 1
        next
      }
      $0 == end {
        if (!skipping) exit 43
        skipping = 0
        next
      }
      !skipping { print }
      END {
        if (skipping) exit 44
      }
    ' "$ENV_FILE" > "$ENV_CANDIDATE" ||
    fail "existing managed block is malformed"

  printf '\n' >> "$ENV_CANDIDATE"
  cat "$MANAGED_BLOCK_FILE" >> "$ENV_CANDIDATE"
  chmod 600 "$ENV_CANDIDATE"
  chown root:root "$ENV_CANDIDATE"

  if ! docker compose \
    --env-file "$ENV_CANDIDATE" \
    -f "$COMPOSE_FILE" \
    -f "$TLS_COMPOSE_FILE" \
    config --quiet >/dev/null 2>&1
  then
    fail "candidate environment does not produce a valid Compose configuration"
  fi

  ENV_BACKUP="$(mktemp "${DEPLOY_ROOT}/.env.backup.XXXXXX")"
  cp --preserve=mode,ownership,timestamps "$ENV_FILE" "$ENV_BACKUP"
  mv -f "$ENV_CANDIDATE" "$ENV_FILE"
  ENV_CANDIDATE=""
  ENV_UPDATED="true"
  echo "[deploy] authentication configuration updated."
}

rollback_environment() {
  if [[ "$ENV_UPDATED" == "true" && -f "$ENV_BACKUP" ]]; then
    chmod 600 "$ENV_BACKUP"
    chown root:root "$ENV_BACKUP"
    mv -f "$ENV_BACKUP" "$ENV_FILE"
    ENV_BACKUP=""
    ENV_UPDATED="false"
    echo "[deploy] authentication configuration rolled back." >&2
  fi
}

cd "$DEPLOY_ROOT"

if IFS= read -r payload_header; then
  sync_auth_environment "$payload_header"
else
  echo "[deploy] no authentication payload supplied; keeping existing configuration."
fi

COMPOSE=(
  docker compose
  -f "$COMPOSE_FILE"
  -f "$TLS_COMPOSE_FILE"
)

echo "[deploy] pulling images..."
if ! "${COMPOSE[@]}" pull gateway frontend; then
  rollback_environment
  echo "[deploy] FAILED: could not pull deployment images." >&2
  exit 1
fi

echo "[deploy] recreating gateway + frontend..."
if ! "${COMPOSE[@]}" up -d --force-recreate --no-deps gateway frontend; then
  rollback_environment
  "${COMPOSE[@]}" up -d --force-recreate --no-deps gateway frontend \
    >/dev/null 2>&1 || true
  echo "[deploy] FAILED: could not recreate gateway and frontend." >&2
  exit 1
fi

echo "[deploy] waiting for gateway health..."
status="unknown"
for _ in $(seq 1 30); do
  status="$(
    docker inspect --format "{{.State.Health.Status}}" cheers-gateway-1 2>/dev/null ||
      printf '%s' unknown
  )"
  if [[ "$status" == "healthy" ]]; then
    echo "[deploy] gateway healthy."
    docker image prune -f >/dev/null
    echo "[deploy] done."
    exit 0
  fi
  sleep 2
done

echo "[deploy] FAILED: gateway not healthy after 60s (status: ${status})" >&2
rollback_environment
"${COMPOSE[@]}" up -d --force-recreate --no-deps gateway frontend \
  >/dev/null 2>&1 || true
exit 1

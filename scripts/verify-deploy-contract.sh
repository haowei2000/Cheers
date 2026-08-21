#!/usr/bin/env bash
set -euo pipefail

readonly DEPLOY_SCRIPT_PATH="${DEPLOY_SCRIPT_PATH:-deploy/production/deploy.sh}"
readonly SSH_DIRECTORY="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/cheers-deploy-ssh"

for name in SSH_KEY KNOWN_HOSTS HOST USER; do
  if [[ -z "${!name:-}" ]]; then
    echo "::error::required deploy contract setting is missing: ${name}" >&2
    exit 1
  fi
done

[[ -f "$DEPLOY_SCRIPT_PATH" ]] || {
  echo "::error::deploy script not found: ${DEPLOY_SCRIPT_PATH}" >&2
  exit 1
}

install -m 700 -d "$SSH_DIRECTORY"
printf '%s\n' "$SSH_KEY" > "${SSH_DIRECTORY}/deploy_key"
chmod 600 "${SSH_DIRECTORY}/deploy_key"
printf '%s\n' "$KNOWN_HOSTS" > "${SSH_DIRECTORY}/known_hosts"

payload="$(mktemp)"
trap 'rm -f "$payload"' EXIT
chmod 600 "$payload"
expected_sha="$(sha256sum "$DEPLOY_SCRIPT_PATH" | awk '{print $1}')"
printf '%s\n%s\n' 'CHEERS_DEPLOY_PREFLIGHT_V1' "$expected_sha" > "$payload"

if ! ssh -i "${SSH_DIRECTORY}/deploy_key" \
    -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="${SSH_DIRECTORY}/known_hosts" \
    "$USER@$HOST" deploy < "$payload"; then
  echo "::error::production deploy contract is stale or unreachable." >&2
  echo "::error::install deploy/production/deploy.sh on the server, then retry the workflow." >&2
  exit 1
fi

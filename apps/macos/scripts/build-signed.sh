#!/usr/bin/env bash
# Local signed desktop build. Uses ~/.cheers-release/desktop-updater.key
# (same material as GitHub secret DESKTOP_UPDATER_KEY / 1Password).
set -euo pipefail
cd "$(dirname "$0")/.."

KEY_FILE="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.cheers-release/desktop-updater.key}"
if [[ ! -f "$KEY_FILE" ]]; then
  echo "missing updater private key: $KEY_FILE" >&2
  exit 1
fi

export TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
unset CARGO_TARGET_DIR

npm run build

BUNDLE="src-tauri/target/release/bundle"
echo ""
echo "Artifacts:"
ls -la "$BUNDLE/macos/" 2>/dev/null || true
ls -la "$BUNDLE/dmg/" 2>/dev/null || true

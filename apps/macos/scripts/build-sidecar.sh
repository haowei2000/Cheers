#!/usr/bin/env bash
# Build the connector from the monorepo and stage it as a Tauri sidecar.
# Sidecar binaries must carry the target-triple suffix (Tauri contract).
set -euo pipefail
cd "$(dirname "$0")/.."

TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
DEST="src-tauri/binaries/cce-acp-connector-${TRIPLE}"

cargo build --release \
  --manifest-path ../../packages/cheers-acp-connector-rs/Cargo.toml \
  --bin cce-acp-connector

mkdir -p src-tauri/binaries
cp "../../packages/cheers-acp-connector-rs/target/release/cce-acp-connector" "$DEST"
echo "sidecar staged: $DEST"

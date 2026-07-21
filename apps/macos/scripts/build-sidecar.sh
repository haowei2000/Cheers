#!/usr/bin/env bash
# Build the connector and its Cheers MCP companion from the monorepo, then
# stage both as Tauri sidecars. The connector starts the MCP binary for each
# ACP session, so shipping only the connector leaves desktop-created bots with
# no Cheers tool surface. Sidecar binaries must carry the target-triple suffix
# (Tauri contract).
set -euo pipefail
cd "$(dirname "$0")/.."

TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
DEST="src-tauri/binaries/cce-acp-connector-${TRIPLE}"

cargo build --release \
  --manifest-path ../../packages/cheers-acp-connector-rs/Cargo.toml \
  --bin cce-acp-connector
cargo build --release \
  --manifest-path ../../packages/cheers-mcp-server/Cargo.toml \
  --bin cheers-mcp-server

mkdir -p src-tauri/binaries
cp "../../packages/cheers-acp-connector-rs/target/release/cce-acp-connector" "$DEST"
MCP_DEST="src-tauri/binaries/cheers-mcp-server-${TRIPLE}"
cp "../../packages/cheers-mcp-server/target/release/cheers-mcp-server" "$MCP_DEST"
echo "sidecars staged: $DEST, $MCP_DEST"

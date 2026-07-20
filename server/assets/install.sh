#!/usr/bin/env bash
# Cheers connector installer (bot onboarding — mode 2).
#
# Canonical use (code via env, NEVER on the command line / URL):
#   CHEERS_ENROLL_CODE='agbenr_…' bash <(curl -fsSL https://<host>/api/v1/install.sh)
#   ^ note the LEADING SPACE: with `HISTCONTROL=ignorespace` the code stays out
#     of your shell history. The code is single-use and expires in ~15 min.
#
# What it does: redeems the one-time code over the API → receives a freshly
# rotated bot token + a ready connector config → writes both (token to a 0600
# sidecar) → installs a keep-alive service (launchd/systemd) → starts it.
#
# Env knobs:
#   CHEERS_ENROLL_CODE   the one-time code (required; prompted if a TTY)
#   CHEERS_API_BASE      gateway API base; default injected at serve time
#   CHEERS_CONNECTOR_BIN path to cce-acp-connector (else found on PATH, else a
#                        prebuilt release binary is downloaded for this platform)
#   CHEERS_CONNECTOR_REPO     GitHub owner/repo for releases (default ElePerson/Cheers)
#   CHEERS_CONNECTOR_VERSION  connector version, e.g. 0.1.22 (default: latest)
#   CHEERS_INSTALL_DAEMON=0  skip the launchd/systemd unit (just write + start)
#   CHEERS_AUTO_UPDATE=1 enable signed self-update in the written config
#                        (only applied when this script downloaded the binary,
#                        i.e. it is provably >= 0.1.27 — older binaries reject
#                        configs containing the [update] section)
set -euo pipefail

API_BASE="${CHEERS_API_BASE:-__CHEERS_API_BASE__}"
CONFIG_DIR="${CHEERS_CONFIG_DIR:-$HOME/.cheers}"

die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }

# Detect an un-substituted placeholder. The serve-time replace is a global
# string substitution, so the sentinel here is split into two literals that
# never form the contiguous token — only the assignment above gets rewritten.
_PLACEHOLDER='__CHEERS''_API_BASE__'
if [ -z "$API_BASE" ] || [ "$API_BASE" = "$_PLACEHOLDER" ]; then
  die "CHEERS_API_BASE is not set. Re-run with CHEERS_API_BASE=https://<host>/api/v1"
fi
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v python3 >/dev/null 2>&1 || die "python3 is required (used to parse JSON safely)"

# ── 1. resolve the one-time code (env, then TTY prompt — never an argument) ────
CODE="${CHEERS_ENROLL_CODE:-}"
if [ -z "$CODE" ]; then
  if [ -t 0 ]; then
    printf 'Enrollment code (agbenr_…): ' >&2
    read -rs CODE; printf '\n' >&2
  fi
fi
[ -n "$CODE" ] || die "no enrollment code (set CHEERS_ENROLL_CODE)"

# ── 2. redeem (single-use, over the API). Response holds token + config. ──────
info "redeeming enrollment code at $API_BASE …"
RESP_FILE="$(mktemp)"
trap 'rm -f "$RESP_FILE"' EXIT
# Code goes in the JSON body, never the URL/argv. --fail-with-body keeps the
# opaque 400 message; we don't echo the code on any path.
if ! printf '{"code":"%s"}' "$CODE" \
    | curl -fsS -X POST "$API_BASE/enrollment/redeem" \
        -H 'Content-Type: application/json' --data-binary @- > "$RESP_FILE"; then
  die "redeem failed — code invalid, expired, already used, or gateway unreachable"
fi

field() { python3 -c 'import sys,json; sys.stdout.write(str(json.load(open(sys.argv[1])).get(sys.argv[2],"")))' "$RESP_FILE" "$1"; }
ACCOUNT_ID="$(field account_id)"
TOKEN_FILE="$(field token_file)"      # relative, e.g. secrets/codex.token
CONTROL_URL="$(field control_url)"
AGENT_TYPE="$(field agent_type)"
[ -n "$ACCOUNT_ID" ] && [ -n "$TOKEN_FILE" ] || die "unexpected redeem response"

CONFIG_FILE="$CONFIG_DIR/cheers-daemon.$ACCOUNT_ID.toml"
TOKEN_PATH="$CONFIG_DIR/$TOKEN_FILE"

# ── 3. write config + token (token straight to a 0600 file, never a var) ──────
mkdir -p "$CONFIG_DIR/workspace" "$(dirname "$TOKEN_PATH")"
python3 -c 'import sys,json; sys.stdout.write(json.load(open(sys.argv[1]))["config_toml"])' "$RESP_FILE" > "$CONFIG_FILE"
umask 077
python3 -c 'import sys,json; sys.stdout.write(json.load(open(sys.argv[1]))["token"])' "$RESP_FILE" > "$TOKEN_PATH"
chmod 600 "$TOKEN_PATH"
info "wrote config → $CONFIG_FILE"
info "wrote token  → $TOKEN_PATH (chmod 600)"

# ── 4. locate (or download) the connector binary ──────────────────────────────
BIN="${CHEERS_CONNECTOR_BIN:-}"
if [ -z "$BIN" ]; then
  BIN="$(command -v cce-acp-connector 2>/dev/null || true)"
fi
# Not on PATH → fetch a prebuilt binary. SAME-ORIGIN first: this host provably
# reaches the gateway (install.sh came from it) while GitHub may be firewalled;
# the gateway proxies the release asset through. GitHub is the fallback. A
# downloaded binary must pass a RUN CHECK before we accept it — a binary built
# against a newer glibc "downloads fine" and then crash-loops the keep-alive
# service (seen in the wild: GLIBC_2.39 binary on Ubuntu 22.04 / glibc 2.35).
if [ -z "$BIN" ]; then
  REPO="${CHEERS_CONNECTOR_REPO:-ElePerson/Cheers}"
  VER="${CHEERS_CONNECTOR_VERSION:-latest}"
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os" in Darwin) os=darwin ;; Linux) os=linux ;; *) os="" ;; esac
  case "$arch" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=amd64 ;; *) arch="" ;; esac
  if [ -n "$os" ] && [ -n "$arch" ]; then
    ASSET="cce-acp-connector-$os-$arch"
    if [ "$VER" = "latest" ]; then
      GH_URL="https://github.com/$REPO/releases/latest/download/$ASSET"
    else
      GH_URL="https://github.com/$REPO/releases/download/connector-v$VER/$ASSET"
    fi
    DEST="$CONFIG_DIR/bin/cce-acp-connector"
    mkdir -p "$CONFIG_DIR/bin"
    for SRC in "$API_BASE/connector/download/$ASSET" "$GH_URL"; do
      info "downloading connector binary ($os/$arch) from $SRC …"
      if curl -fsSL "$SRC" -o "$DEST" && [ -s "$DEST" ]; then
        chmod +x "$DEST"
        # Run check: --help must exit 0. Captures the loader error (e.g.
        # "version GLIBC_2.39 not found") so the failure is explainable.
        if RUN_ERR="$("$DEST" --help </dev/null 2>&1 >/dev/null)"; then
          BIN="$DEST"
          BIN_DOWNLOADED=1
          info "installed connector → $BIN"
          break
        else
          info "downloaded binary does not run here (${RUN_ERR:-unknown error}) — trying next source"
          rm -f "$DEST"
        fi
      else
        rm -f "$DEST"
      fi
    done
    [ -n "$BIN" ] || info "no usable prebuilt binary for $os/$arch (will fall back to build instructions)"
  fi
fi

# ── 4a. opt-in signed self-update (CHEERS_AUTO_UPDATE=1) ──────────────────────
# Only when THIS script downloaded the binary: a fresh release download is
# provably >= 0.1.27 and parses [update]; a PATH/user-supplied binary may be
# older and would crash-loop on a config containing the section.
if [ "${CHEERS_AUTO_UPDATE:-0}" = "1" ]; then
  if [ "${BIN_DOWNLOADED:-0}" = "1" ]; then
    python3 - "$CONFIG_FILE" <<'PYUP'
import sys
path = sys.argv[1]
text = open(path).read()
commented = "# [update]\n# auto = true"
if "[update]" in text.replace(commented, ""):
    pass  # already enabled
elif commented in text:
    text = text.replace(commented, "[update]\nauto = true", 1)
else:
    text += "\n[update]\nauto = true\n"
open(path, "w").write(text)
PYUP
    info "signed self-update ENABLED ([update] auto = true)"
  else
    info "WARNING: CHEERS_AUTO_UPDATE=1 ignored — using a pre-existing binary that may predate 0.1.27; update it first, then set [update] auto = true in $CONFIG_FILE"
  fi
fi

# ── 4b. install the cheers MCP server next to the connector ───────────────────
# The connector injects this stdio MCP server into every agent session and
# resolves it from the directory of its own executable, so it must live next to
# the connector binary. Best-effort: the bot works without it, but agents lose
# their cheers platform tools (send message / fetch resources).
if [ -n "$BIN" ] && [ -n "${os:-}" ] && [ -n "${arch:-}" ]; then
  MCP_DEST="$(dirname "$BIN")/cheers-mcp-server"
  if [ ! -x "$MCP_DEST" ]; then
    MCP_ASSET="cheers-mcp-server-$os-$arch"
    if [ "$VER" = "latest" ]; then
      MCP_GH_URL="https://github.com/$REPO/releases/latest/download/$MCP_ASSET"
    else
      MCP_GH_URL="https://github.com/$REPO/releases/download/connector-v$VER/$MCP_ASSET"
    fi
    for MCP_SRC in "$API_BASE/connector/download/$MCP_ASSET" "$MCP_GH_URL"; do
      info "downloading cheers MCP server ($os/$arch) from $MCP_SRC …"
      if curl -fsSL "$MCP_SRC" -o "$MCP_DEST" && [ -s "$MCP_DEST" ]; then
        chmod +x "$MCP_DEST"
        info "installed MCP server → $MCP_DEST"
        break
      fi
      rm -f "$MCP_DEST"
    done
    [ -x "$MCP_DEST" ] || info "WARNING: no prebuilt cheers-mcp-server for $os/$arch — agent sessions will lack cheers MCP tools (set CHEERS_MCP_SERVER_BIN to a locally built binary to fix)"
  fi
fi
if [ -z "$BIN" ]; then
  cat >&2 <<EOF

  Config and token are in place, but no connector binary was found and none could
  be downloaded for this platform. Build it once:
      git clone https://github.com/ElePerson/Cheers && cd Cheers/packages/cheers-acp-connector-rs
      cargo build --release    # → target/release/cce-acp-connector
  then re-run with CHEERS_CONNECTOR_BIN=/path/to/cce-acp-connector, or start by hand:
      cce-acp-connector start --config "$CONFIG_FILE" --name "$ACCOUNT_ID"
EOF
  exit 0
fi
info "connector binary: $BIN"

# ── 4c. the ACP agent adapter the config references must exist ────────────────
# The generated config spawns an agent adapter (adapter.command — e.g.
# `claude-agent-acp` for agent_type=claude). It is NOT shipped with the
# connector, and a keep-alive unit whose adapter is missing just crash-loops.
# Resolve it to an ABSOLUTE path in the config (launchd/systemd don't see a
# login-shell PATH), auto-installing the known npm adapter when possible;
# otherwise skip the keep-alive install and say exactly how to finish. npm ACP
# packages can be JavaScript shims headed by `#!/usr/bin/env node`; a launchd or
# systemd child has no reliable interactive PATH, so persist those as an
# explicit Node binary plus the shim path as the first argument.
ADAPTER="$(sed -n 's/^command[[:space:]]*=[[:space:]]*"\(.*\)".*$/\1/p' "$CONFIG_FILE" | head -1)"
ADAPTER_OK=1
ADAPTER_RESOLVED=""
case "$ADAPTER" in
  "") : ;; # no adapter line (unusual config) — nothing to check
  /*)
    if [ -x "$ADAPTER" ]; then ADAPTER_RESOLVED="$ADAPTER"; else ADAPTER_OK=0; fi
    ;;
  *)
    ADAPTER_ABS="$(command -v "$ADAPTER" 2>/dev/null || true)"
    if [ -z "$ADAPTER_ABS" ] && [ "$ADAPTER" = "claude-agent-acp" ] && command -v npm >/dev/null 2>&1; then
      info "agent adapter '$ADAPTER' not found — installing @agentclientprotocol/claude-agent-acp (npm -g) …"
      npm install -g @agentclientprotocol/claude-agent-acp >/dev/null 2>&1 || true
      ADAPTER_ABS="$(command -v claude-agent-acp 2>/dev/null || true)"
    fi
    if [ -n "$ADAPTER_ABS" ]; then
      ADAPTER_RESOLVED="$ADAPTER_ABS"
    else
      ADAPTER_OK=0
    fi
    ;;
esac

if [ "$ADAPTER_OK" = "1" ] && [ -n "$ADAPTER_RESOLVED" ]; then
  if [ "$(head -n 1 "$ADAPTER_RESOLVED" 2>/dev/null || true)" = "#!/usr/bin/env node" ]; then
    NODE_BIN="$(command -v node 2>/dev/null || true)"
    if [ -z "$NODE_BIN" ]; then
      ADAPTER_OK=0
      ADAPTER_ERROR="the adapter needs Node.js, but node was not found on PATH"
    else
      python3 - "$CONFIG_FILE" "$NODE_BIN" "$ADAPTER_RESOLVED" <<'PY'
import json, re, sys
path, node, script = sys.argv[1:]
text = open(path).read()
text, count = re.subn(r'(?m)^(\s*)command\s*=\s*"[^"]*"\s*$', lambda m: f'{m.group(1)}command = {json.dumps(node)}', text, count=1)
if count != 1:
    raise SystemExit("could not update adapter.command")
def add_script(match):
    existing = match.group(2).strip()
    values = json.dumps(script)
    return f'{match.group(1)}args = [{values}{", " + existing if existing else ""}]'
text, count = re.subn(r'(?m)^(\s*)args\s*=\s*\[(.*)\]\s*$', add_script, text, count=1)
if count != 1:
    raise SystemExit("could not update adapter.args")
open(path, "w").write(text)
PY
      info "agent adapter: $NODE_BIN $ADAPTER_RESOLVED (explicit Node launcher baked into the config)"
    fi
  else
    sed -i.cheers-bak "s|^command[[:space:]]*=[[:space:]]*\"$ADAPTER\"|command = \"$ADAPTER_RESOLVED\"|" "$CONFIG_FILE" \
      && rm -f "$CONFIG_FILE.cheers-bak"
    info "agent adapter: $ADAPTER_RESOLVED (absolute path baked into the config)"
  fi
fi
if [ "$ADAPTER_OK" = "0" ]; then
  cat >&2 <<EOF

  The agent adapter '$ADAPTER' referenced by the config is not ready${ADAPTER_ERROR:+ ($ADAPTER_ERROR)}, so the
  keep-alive service is NOT being enabled (it would only crash-loop). To finish:
    1. install the adapter, e.g. for Claude:  npm install -g @agentclientprotocol/claude-agent-acp
    2. put its ABSOLUTE path into $CONFIG_FILE (adapter.command), then:
       systemctl --user enable --now cheers-connector-$ACCOUNT_ID.service   # linux
       # (macOS: launchctl load ~/Library/LaunchAgents/com.cheers.connector.$ACCOUNT_ID.plist)
  Config + token are already in place — no new enrollment code is needed.
EOF
fi

# ── 5. keep-alive service (default on; skipped while the adapter is missing) ──
START_BY_HAND=1
if [ "${CHEERS_INSTALL_DAEMON:-1}" = "1" ] && [ "$ADAPTER_OK" = "1" ]; then
  OS="$(uname -s)"
  if [ "$OS" = "Darwin" ]; then
    LABEL="com.cheers.connector.$ACCOUNT_ID"
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$BIN</string><string>run</string><string>--config</string><string>$CONFIG_FILE</string><string>--name</string><string>$ACCOUNT_ID</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$CONFIG_DIR/$ACCOUNT_ID.out.log</string>
  <key>StandardErrorPath</key><string>$CONFIG_DIR/$ACCOUNT_ID.err.log</string>
</dict></plist>
EOF
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    launchctl load "$PLIST"
    info "installed launchd unit → $PLIST"
    START_BY_HAND=0
  elif command -v systemctl >/dev/null 2>&1; then
    UNIT_DIR="$HOME/.config/systemd/user"
    UNIT="$UNIT_DIR/cheers-connector-$ACCOUNT_ID.service"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT" <<EOF
[Unit]
Description=Cheers ACP connector ($ACCOUNT_ID)
After=network-online.target

[Service]
ExecStart=$BIN run --config $CONFIG_FILE --name $ACCOUNT_ID
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "cheers-connector-$ACCOUNT_ID.service"
    info "installed systemd --user unit → $UNIT"
    START_BY_HAND=0
  else
    info "no launchd/systemd found — falling back to the connector's own daemon"
  fi
fi

# ── 6. fallback start + status ────────────────────────────────────────────────
if [ "$ADAPTER_OK" = "0" ]; then
  # Starting now would only crash — the finish steps were printed above.
  printf '\n\033[1;33m! incomplete.\033[0m bot "%s" (%s) installed but NOT started — install the agent adapter, then start the service.\n' "$ACCOUNT_ID" "$AGENT_TYPE"
  exit 1
fi
if [ "$START_BY_HAND" = "1" ]; then
  "$BIN" start --config "$CONFIG_FILE" --name "$ACCOUNT_ID" || true
fi
sleep 1
"$BIN" status --name "$ACCOUNT_ID" || true

printf '\n\033[1;32m✓ done.\033[0m bot "%s" (%s) connecting to %s\n' "$ACCOUNT_ID" "$AGENT_TYPE" "$CONTROL_URL"
if [ "${CHEERS_AUTO_UPDATE:-0}" != "1" ]; then
  info "tip: signed self-update is available — set [update] auto = true in $CONFIG_FILE (connector >= 0.1.27), or re-install with CHEERS_AUTO_UPDATE=1"
fi

#!/usr/bin/env python3
"""Seed ONLY a running loopback demo gateway; persist its private connector
config under ignored .tmp/. The deterministic agent uses real ACP + MCP.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / ".tmp/ui-cards-demo"
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18381"
if urlsplit(BASE).hostname not in {"127.0.0.1", "localhost", "::1"}:
    raise SystemExit("This fixture only targets a loopback demo gateway.")


def api(path, body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(f"{BASE}/api/v1{path}", None if body is None else json.dumps(body).encode(), headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{path}: {error.code} {error.read().decode()}") from error


def main():
    STATE.mkdir(parents=True, exist_ok=True)
    auth = api("/auth/login", {"login": "ui-demo", "password": "Cheers-UI-Demo-2026!", "client": "web"})
    token = auth["access_token"]
    if (STATE / "demo.json").exists():
        print("Demo already provisioned:", STATE / "demo.json")
        return
    workspaces = api("/workspaces", token=token)
    workspace = next((ws for ws in workspaces if ws["name"] == "Intelligent Cards Demo"), None)
    if workspace is None:
        workspace = api("/workspaces", {"name": "Intelligent Cards Demo"}, token)
    channels = api(f"/channels?workspace_id={workspace['workspace_id']}", token=token)
    channel = next((ch for ch in channels if ch["name"] == "interactive-cards"), None)
    if channel is None:
        channel = api("/channels", {"workspace_id": workspace["workspace_id"], "name": "interactive-cards"}, token)
    bots = api("/bots", token=token)
    bot = next((item for item in bots if item["username"] == "ui-demo-bot"), None)
    if bot is None:
        bot = api("/bots", {"username": "ui-demo-bot", "display_name": "演示 Bot · 确定性 ACP",
            "description": "Local deterministic fixture. No external model calls.", "binding_type": "agent_bridge", "bridge_provider": "acp", "external_processor": False}, token)
    members = api(f"/channels/{channel['channel_id']}/members", token=token)
    if not any(member["member_id"] == bot["bot_id"] for member in members):
        api(f"/channels/{channel['channel_id']}/members", {"member_id": bot["bot_id"], "member_type": "bot", "role": "member"}, token)
    paired = api(f"/bots/{bot['bot_id']}/hosts", {"agent_type": "generic", "device_name": "UI cards demo"}, token)
    host = api("/hosts/redeem", {"pairing_code": paired["pairing_code"], "device_name": "UI cards demo"})
    credential = STATE / host["credential_file"]
    credential.parent.mkdir(parents=True, exist_ok=True)
    credential.write_text(host["credential"]); credential.chmod(0o600)
    config = host["config_toml"]
    config = re.sub(r'^command\s*=.*$', f"command = {json.dumps(sys.executable)}", config, flags=re.M)
    config = re.sub(r'^args\s*=.*$', f"args = [{json.dumps(str(ROOT / 'scripts/demo/interactive_agent.py'))}]", config, flags=re.M)
    config = re.sub(r'^default_cwd\s*=.*$', f"default_cwd = {json.dumps(str(STATE / 'workspace'))}", config, flags=re.M)
    config = re.sub(r'^allowed_roots\s*=.*$', f"allowed_roots = [{json.dumps(str(STATE / 'workspace'))}]", config, flags=re.M)
    config_path = STATE / "connector.toml"
    config_path.write_text(config); config_path.chmod(0o600)
    manifest = {"base": BASE, "workspace_id": workspace["workspace_id"], "channel_id": channel["channel_id"], "bot_id": bot["bot_id"],
        "account_id": host["account_id"], "config_path": str(config_path), "connector_home": str(STATE / "connector-home"),
        "login": "ui-demo", "password": "Cheers-UI-Demo-2026!"}
    (STATE / "demo.json").write_text(json.dumps(manifest, indent=2)); (STATE / "demo.json").chmod(0o600)
    env = os.environ.copy(); env["CHEERS_ACP_HOME"] = manifest["connector_home"]
    subprocess.run([str(ROOT / "packages/cheers-acp-connector-rs/target/release/cce-acp-connector"), "--name", "ui-cards-demo", "--config", str(config_path), "start"], env=env, check=True)
    print("Demo workspace:", workspace["workspace_id"])
    print("Demo channel:", channel["channel_id"])
    print("Private runtime manifest:", STATE / "demo.json")


if __name__ == "__main__":
    main()

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { mockIPC } from "@tauri-apps/api/mocks";
import { ThemeProvider } from "@/components/ui/theme";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import LoginPage from "@/features/auth/LoginPage";
import { CreateBotDialog } from "@/features/bots/CreateBotDialog";
import { LocalHostSetup } from "./LocalHostSetup";
import "@/index.css";

// Gateway-free preview. Run pnpm dev, then /dev/onboarding.html.
// ?screen=login|bot|host and ?mode=ready|standby|save-error|start-error|busy|empty
// exercise actual controls without installing agents or writing local files.
const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "ready";
const bot = { bot_id: "preview-bot", username: "helper", display_name: "My assistant" };
let running = false;
mockIPC(async (command) => {
  if (command === "detect_agents") return [
    { key: "codex", label: "Codex", installed: true, installable: true, path: "/usr/local/bin/codex-acp" },
    { key: "claude", label: "Claude", installed: true, installable: true, path: "/usr/local/bin/claude-agent-acp" },
  ];
  if (command === "plugin:dialog|open") return "/Users/preview/Projects/a-repository-with-a-long-name/packages/agent-workspace";
  if (command === "connector_write_onboarded") {
    if (mode === "save-error") throw new Error("The selected folder is no longer available. Choose an existing project folder.");
    return "/preview/cheers-daemon.helper-host.toml";
  }
  if (command === "connector_list") return running ? [{ name: "helper-preview-host", running: true }] : [];
  if (command === "connector_start") {
    if (mode === "start-error") throw new Error("The agent could not start. Check its installation and retry the saved host.");
    if (mode === "busy") await new Promise((resolve) => setTimeout(resolve, 60_000));
    running = true;
    return;
  }
  throw new Error(`Preview does not implement ${command}`);
});

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const path = new URL(input instanceof Request ? input.url : String(input), location.origin).pathname;
  if (!path.includes("/api/v1/")) return originalFetch(input, init);
  let data: unknown;
  if (path.endsWith("/auth/capabilities")) data = { providers: { apple: true, google: true, github: true, password: true }, passkey: true };
  else if (path.endsWith("/bots") && init?.method === "POST") data = bot;
  else if (path.endsWith("/hosts/redeem")) data = { account_id: "helper", credential: "preview-only", credential_file: "preview.token", config_toml: "preview" };
  else if (path.endsWith("/hosts") && init?.method === "POST") data = { host_id: "preview-host", pairing_code: "preview-only" };
  else if (path.endsWith("/hosts") && init?.method === "DELETE") data = { ok: true };
  else if (path.endsWith("/hosts")) data = { hosts: [{ host_id: "preview-host", online: running, status: mode === "standby" ? "standby" : "active" }] };
  else if (init?.method === "DELETE") data = { ok: true };
  else if (path.endsWith("/channels/dm")) data = { channel_id: "preview-dm", channel_type: "dm", name: "My assistant" };
  else if (path.includes("/sessions")) data = { session_id: "preview-session" };
  else throw new Error(`Preview does not implement ${path}`);
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
};

function Preview() {
  const [screen, setScreen] = useState(params.get("screen") ?? "host");
  const [open, setOpen] = useState(true);
  if (screen === "login") return <LoginPage />;
  return <main className="min-h-screen bg-canvas p-4 text-content-primary">
    <Button action="open" onClick={() => setOpen(true)} aria-label="Open onboarding preview" />
    {open && (screen === "bot"
      ? <CreateBotDialog onClose={() => setOpen(false)} onCreated={() => setScreen("host")} />
      : <Dialog title="Connect bot and project" onClose={() => setOpen(false)}>
        <LocalHostSetup bots={mode === "empty" ? [] : [bot]} onDone={() => setOpen(false)} />
      </Dialog>)}
  </main>;
}

createRoot(document.getElementById("root")!).render(<ThemeProvider><MemoryRouter><Preview /></MemoryRouter></ThemeProvider>);

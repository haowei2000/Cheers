import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { BotPostureSection } from "@/features/bots/BotPostureSection";
import { SessionChip } from "./SessionChip";
import { ComposerModelPopover } from "./ComposerModelPopover";
import { MessageComposer } from "./MessageComposer";
import type { ConfigOption } from "@/api/bots";
import type { SendResourceReq } from "./workbench/fsClient";
import "@/index.css";

const cases = ["ready", "empty", "discovery", "long", "error"] as const;
type Case = typeof cases[number];
const params = new URLSearchParams(location.search);
const scenario = (cases.includes(params.get("case") as Case) ? params.get("case") : "ready") as Case;
const botId = `fixture-${scenario}`;
const channelId = `preview-${scenario}`;
const botName = scenario === "long" ? "codex-with-a-very-long-agent-name" : "hwcodex";
const model: ConfigOption = {
  id: "model", name: "Model", category: "model", type: "select", currentValue: "gpt-default",
  options: [
    { value: "gpt-default", name: "GPT-5" },
    { value: "gpt-session", name: scenario === "long" ? "A very long discovered model name with reasoning" : "GPT-5 fast" },
  ],
};
const options: ConfigOption[] = scenario === "empty" ? [] : [model, {
  id: "reasoning_effort", name: "Reasoning effort", type: "select", currentValue: "medium",
  options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }],
}];
const sessions = scenario === "empty" ? [] : [
  { session_id: "primary", bot_id: botId, bot_name: botName, is_primary: true, role: "primary", status: "idle", last_used_at: "", workspace: { cwd: "/workspace/default" } },
  { session_id: "pinned", bot_id: botId, bot_name: botName, is_primary: false, role: "other", status: "idle", last_used_at: "", workspace: { cwd: "/workspace/a-long-project-directory" }, session_config: { config_options: { model: "gpt-session" } } },
];
const requestCounts = new Map<string, number>();

// This isolated page answers every fetch locally. Nothing reaches a gateway or agent.
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  const path = url.pathname;
  const count = (requestCounts.get(path) ?? 0) + 1;
  requestCounts.set(path, count);
  const availableOptions = scenario === "discovery" && count === 1 ? [] : options;
  let payload: unknown;
  let status = 200;
  if (scenario === "error" && count === 1 && /session-controls$|permissions$/.test(path)) {
    payload = { detail: "Fixture connection interrupted. Retry to reconnect." };
    status = 503;
  } else if (init?.method && init.method !== "GET") {
    payload = { ok: true };
  } else if (path.endsWith("/session-controls")) {
    payload = { can_set_mode: true, can_set_config_option: true, can_create_session: false, can_close_session: true, can_set_primary: true, allowed_modes: ["default", "auto"], current_mode: "default", config_options: availableOptions };
  } else if (path.endsWith("/sessions")) {
    payload = { sessions };
  } else if (path.endsWith("/permissions")) {
    payload = { posture: { agent_type: "codex", permission_mode: "default", allowed_modes: ["default", "auto"] }, config_options: { advertised: availableOptions, desired: {} } };
  } else {
    payload = { detail: "This local fixture does not implement that request." };
    status = 501;
  }
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
};
const sendResourceReq: SendResourceReq = async (verb) => {
  if (verb === "channel.sessions.read") return { sessions };
  throw new Error("This fixture only reads local sessions.");
};

function Example() {
  const [selected, setSelected] = useState(scenario === "empty" ? "" : "pinned");
  return <main className="min-h-screen space-y-6 bg-canvas p-4 text-content-primary">
    <h1 className="text-title">Agent options · {scenario}</h1>
    <BotPostureSection botId={botId} />
    <div className="min-h-[240px]" aria-hidden="true" />
    <MessageComposer channelId={channelId} channelName="preview" sessionTargetName={selected ? botName : undefined}
      onSend={async () => {}}
      toolbar={<>
        <SessionChip channelId={channelId} bots={[{ botId, name: botName }]} value={selected} onChange={setSelected} sendResourceReq={sendResourceReq} onManageSessions={() => {}} />
        <ComposerModelPopover channelId={channelId} bots={[{ botId, name: botName }]} selectedSessionId={selected} />
      </>} />
  </main>;
}

function Gallery() {
  const [width, setWidth] = useState(390);
  const [current, setCurrent] = useState<Case>("ready");
  const [dark, setDark] = useState(false);
  return <main className="min-h-screen space-y-4 bg-canvas p-4 text-content-primary">
    <h1 className="text-title">Agent options · local fixture</h1>
    <p className="text-body-secondary">Ready and pinned, empty options, automatic discovery, long names, and retryable failure. Discovery starts empty and becomes ready on the next poll. All requests stay in this page.</p>
    <div className="flex flex-wrap gap-2" role="tablist" aria-label="Scenario">{cases.map(value => <ControlTrigger key={value} role="tab" selected={current === value} onClick={() => setCurrent(value)}>{value}</ControlTrigger>)}</div>
    <div className="flex flex-wrap gap-2" role="tablist" aria-label="Width">{[390, 768, 1280].map(value => <ControlTrigger key={value} role="tab" selected={width === value} onClick={() => setWidth(value)}>{value}px</ControlTrigger>)}</div>
    <ControlTrigger aria-label="Preview dark appearance" aria-pressed={dark} onClick={() => setDark(value => !value)}>Dark</ControlTrigger>
    <div className="overflow-auto"><iframe key={`${current}:${width}:${dark}`} title={`${current} at ${width}px`} src={`/dev/agent-options.html?frame=1&case=${current}&theme=${dark ? "dark" : "light"}`} width={width} height={1000} className="max-w-none border-0" /></div>
  </main>;
}

document.documentElement.dataset.theme = params.get("theme") ?? "light";
// The standalone gallery can be taller than the app's fixed-height shell.
// Keep its composer reachable at enlarged text/zoom instead of clipping it.
for (const element of [document.documentElement, document.body, document.getElementById("root")!]) {
  Object.assign(element.style, { height: "auto", overflow: "visible" });
}
createRoot(document.getElementById("root")!).render(params.has("frame") ? <Example /> : <Gallery />);

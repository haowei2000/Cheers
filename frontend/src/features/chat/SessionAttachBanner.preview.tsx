import { createRoot } from "react-dom/client";
import type { SessionReferenceMatch } from "@/api/sessionControl";
import { SessionAttachBanner, type SessionAttachPhase } from "./SessionAttachBanner";
import "@/index.css";

// Every banner state on one page, for review at 390/768/1280px. Static: no fetch.
const reference = { raw: "codex://threads/01a1422e-d5e6-7e10-be3b-040fa49834a4", app: "Codex thread" };

const match = (
  botId: string,
  device: string | null,
  title: string | null,
  cwd: string,
  cwdAllowed = true,
): SessionReferenceMatch => ({
  bot_id: botId,
  username: "hwcodex",
  display_name: "Codex",
  host_id: `${botId}-host`,
  device_name: device,
  session: {
    session_id: "01a1422e-d5e6-7e10-be3b-040fa49834a4",
    cwd,
    title,
    updated_at: "2026-11-18T07:30:49.000Z",
    cwd_allowed: cwdAllowed,
    cwd_error: cwdAllowed ? null : "cwd is outside local allowed workspace roots",
  },
});

const one = [match("bot-a", "MacBook Pro", "Fix the login redirect loop", "/Users/me/Projects/web")];
const several = [
  ...one,
  match("bot-b", "build-server", null, "/private/tmp", false),
  match("bot-c", null, "A very long thread title that keeps going well past the width of a phone screen", "/Users/me/Projects/a-very-long-project-directory-name/packages/core"),
];

const states: Array<{ label: string; phase: SessionAttachPhase; matches: SessionReferenceMatch[]; error?: string; attaching?: string }> = [
  { label: "Detected", phase: "idle", matches: [] },
  { label: "Looking up", phase: "resolving", matches: [] },
  { label: "One match", phase: "choosing", matches: one },
  { label: "Several matches, one folder not allowed", phase: "choosing", matches: several },
  { label: "Attaching", phase: "attaching", matches: one, attaching: "bot-a" },
  { label: "Not found", phase: "idle", matches: [], error: "No connected agent has this session." },
  { label: "Attach failed", phase: "choosing", matches: one, error: "could not attach the session: session cwd rejected by local policy" },
];

function Preview() {
  return (
    <main className="min-h-screen bg-canvas py-4">
      {states.map((state) => (
        <section key={state.label} aria-label={state.label} className="pb-4">
          <h2 className="mx-auto max-w-6xl px-4 font-utility text-compact text-content-muted max-md:px-3">
            {state.label}
          </h2>
          <SessionAttachBanner
            reference={reference}
            phase={state.phase}
            matches={state.matches}
            attachingBotId={state.attaching}
            error={state.error}
            onLookUp={() => {}}
            onAttach={() => {}}
            onDismiss={() => {}}
          />
        </section>
      ))}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);

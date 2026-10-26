import { createRoot } from "react-dom/client";
import { ContextActionsProvider } from "@/components/ui/context-actions";
import { ThemeProvider } from "@/components/ui/theme";
import { RemoteWorkspaceDialog } from "./RemoteWorkspaceDialog";
import "@/index.css";

// A fixed repo served from a stubbed fetch, so the panel can be reviewed without a
// connector: a dirty working tree, a short history, and one commit with two files.
const CHANNEL = "preview-channel";
const BOT = "preview-bot";
const ROOT = "/Users/dev/Projects/cheers";
const FILE_DIFF = `diff --git a/docs/client-connector.md b/docs/client-connector.md
index 2c824af7..0b962764 100644
--- a/docs/client-connector.md
+++ b/docs/client-connector.md
@@ -7,6 +7,9 @@ endpoint. The behaviour below
 the real binary with a deterministic model and
 fixture.
 
+The first release with this behaviour is **v0.1.56**
+(\`ae8dcd52\`).
+
 ## Running it
 
 Start the connector with`;
const SERVER_DIFF = `diff --git a/server/src/main.rs b/server/src/main.rs
index 1111111..2222222 100644
--- a/server/src/main.rs
+++ b/server/src/main.rs
@@ -1,4 +1,4 @@
 fn main() {
-    run(Config::default());
+    run(Config::from_env());
 }
`;
const COMMIT_HEADER = `commit 01da91149a52fad2775d3c1ba33f41c679f33f00
Author: Haowei Wang <dev@example.com>
Date:   Fri Oct 23 06:19:33 2026 +0200

    docs: record the first release for connector-managed ACP agents

    Co-authored-by: Claude <noreply@example.com>

`;
const now = Date.now();
const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
const commits = [
  { hash: "01da91149a52fad2775d3c1ba33f41c679f33f00", author: "Haowei Wang", date: iso(3), subject: "docs: record the first release for connector-managed ACP agents" },
  { hash: "e0f9bd6c00000000000000000000000000000000", author: "Haowei Wang", date: iso(27), subject: "chore(release): prepare platform 0.1.54 desktop 0.1.44 connector 0.1.56" },
  { hash: "10820c6600000000000000000000000000000000", author: "Haowei Wang", date: iso(50), subject: "fix(frontend): refresh agent options and simplify session composer" },
];
const tree: Record<string, { name: string; is_dir: boolean }[]> = {
  "": [
    { name: "docs", is_dir: true }, { name: "frontend", is_dir: true }, { name: "server", is_dir: true },
    { name: "CLAUDE.md", is_dir: false }, { name: "README.md", is_dir: false },
  ],
  docs: [{ name: "client-connector.md", is_dir: false }, { name: "ROADMAP.md", is_dir: false }],
  server: [{ name: "src", is_dir: true }, { name: "Cargo.toml", is_dir: false }],
  "server/src": [{ name: "main.rs", is_dir: false }],
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (!url.pathname.includes(`/channels/${CHANNEL}/`)) {
    if (url.pathname.includes("/session-controls")) return json({ can_set_mode: false, can_set_config_option: false, can_create_session: true, can_close_session: false, can_set_primary: false, allowed_modes: [] });
    return realFetch(input, init);
  }
  const q = url.searchParams;
  const p = url.pathname.split(`/channels/${CHANNEL}`)[1];
  switch (p) {
    case "/workspace/bots":
      return json({ bots: [{ bot_id: BOT, username: "hwcodex", display_name: "hwcodex", online: true, can_read: true, can_write: true, host_name: "studio.local" }] });
    case "/workspace/meta":
      return json({ allowed_roots: [ROOT], effective_roots: [ROOT], default_cwd: ROOT, backend_may_set_cwd: true, git_ops: "read", max_read_bytes: 1_000_000, max_write_bytes: 1_000_000 });
    case "/workspace/session-workdirs":
      return json({ workdirs: [] });
    case "/workspace/watch":
      return json({ ok: true });
    case "/workspace/unwatch":
      return json({});
    case "/workspace/tree": {
      const path = q.get("path") ?? "";
      return json({ root: ROOT, path, entries: (tree[path] ?? []).map((e) => ({ ...e, path: path ? `${path}/${e.name}` : e.name, size_bytes: 1200 })) });
    }
    case "/workspace/file": {
      const path = q.get("path") ?? "";
      // Every save loses the race, so the conflict strip can be reviewed.
      if (init?.method === "PUT") return new Response(JSON.stringify({ current_etag: "e2", size_bytes: 4310 }), { status: 409, headers: { "Content-Type": "application/json" } });
      if (path === "README.md") return new Response(JSON.stringify({ detail: "E_TOO_LARGE: README.md is 12.4 MB, over this connector's 1 MB read limit" }), { status: 400, headers: { "Content-Type": "application/json" } });
      const content = `# ${path}\n\nPreview content.\n`;
      return json({ root: ROOT, path, filename: path.split("/").pop(), content_type: "text/markdown", size_bytes: content.length, is_text: true, content, content_b64: btoa(content), etag: "e1" });
    }
    case "/workspace/git/status":
      return json({ raw: "", branch: "feat/bot-fleet-icons", upstream: "origin/feat/bot-fleet-icons", ahead: 1, behind: 0, entries: [
        { xy: "M.", path: "docs/client-connector.md" },
        { xy: ".M", path: "server/src/main.rs" },
        { xy: "??", path: "frontend/dev/remote-workspace.html" },
      ] });
    case "/workspace/git/diff":
      return json({ staged: q.get("staged") === "true", diff: q.get("path")?.startsWith("server") ? SERVER_DIFF : q.get("path") ? FILE_DIFF : FILE_DIFF + "\n" + SERVER_DIFF });
    case "/workspace/git/log":
      return json({ commits: q.get("skip") ? [] : commits });
    case "/workspace/git/commit-files":
      return json({ commit: q.get("commit"), files: [{ status: "M", path: "docs/client-connector.md" }, { status: "M", path: "server/src/main.rs" }] });
    case "/workspace/git/show": {
      const path = q.get("path");
      const body = path === "server/src/main.rs" ? SERVER_DIFF : path ? FILE_DIFF : FILE_DIFF + "\n" + SERVER_DIFF;
      return json({ commit: q.get("commit"), diff: path ? body : COMMIT_HEADER + body });
    }
  }
  return json({});
};

const params = new URLSearchParams(location.search);
const theme = params.get("theme");
if (theme === "light" || theme === "dark") {
  try { window.localStorage.setItem("cheers.theme", theme); } catch { /* storage blocked */ }
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <ContextActionsProvider>
      <main className="relative h-screen w-screen overflow-hidden bg-canvas text-content-primary">
        <RemoteWorkspaceDialog
          channelId={CHANNEL}
          initialBotId={BOT}
          onClose={() => undefined}
          currentUserId="me"
          memberNames={new Map([["u-ada", "Ada"], ["u-lin", "Lin"]])}
          workspaceFocus={[
            { user_id: "u-ada", bot_id: BOT, path: "docs/ROADMAP.md" },
            { user_id: "u-lin", bot_id: BOT, path: "docs/client-connector.md" },
          ]}
        />
      </main>
    </ContextActionsProvider>
  </ThemeProvider>,
);

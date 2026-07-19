/** Typed client for the workbench renderer protocol (protocol 1).
 *
 * The normative message reference is docs/developer/PLUGIN_DEVELOPMENT.md §5; this is the
 * TypeScript twin of the vanilla `cheers-plugin-sdk.js` in the parent directory.
 */

export type Format = "markdown" | "json" | "yaml" | "toml" | "xml" | "text";

/** The one file the host assigned to this renderer. */
export interface Assignment {
  path: string;
  format: Format;
  content: string;
  version: number;
  rendererId: string;
}

export interface Host {
  /** Write the assigned file back. At most ONE save may be in flight — `cheers:saved`
   *  carries no request id, so overlapping saves could adopt each other's results. */
  save(content: string): Promise<{ version: number }>;
  /** Read a whitelisted, current-channel resource (channel.info / members / messages …). */
  resource<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  /** Final verdict: the content parsed here can't be rendered. */
  unsupported(reason: string): void;
  /** Navigate the USER's view to a `cheers:` locator. Fire-and-forget. */
  open(uri: string): void;
  /** PREFILL the channel composer — never sends. Fire-and-forget. */
  compose(text: string): void;
  /** A line in the host's dev protocol inspector (session-loaded plugins). */
  log(message: unknown, level?: "info" | "warn" | "error"): void;
}

interface Pending<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}

/** Wire up the protocol and announce readiness. `onRender` fires on the host's reply to
 *  our `cheers:ready` and again after a conflicted save — the only two triggers. An edit
 *  made by someone else (a bot, another member) does NOT push a new render, and there is
 *  no way to re-read the assigned file: always redraw fully from what you are given. */
export function connect(onRender: (file: Assignment) => void): Host {
  let reqId = 0;
  const pendingRes = new Map<number, Pending<unknown>>();
  let pendingSave: Pending<{ version: number }> | null = null;

  window.addEventListener("message", (e: MessageEvent) => {
    const m = e.data as Record<string, unknown> | null;
    if (!m || typeof m !== "object") return;
    if (m.type === "cheers:render") {
      onRender(m as unknown as Assignment);
    } else if (m.type === "cheers:saved") {
      const p = pendingSave;
      pendingSave = null;
      if (!p) return;
      if (m.ok) p.resolve({ version: Number(m.version) });
      else p.reject(new Error(String(m.error ?? "save failed")));
    } else if (m.type === "cheers:resource:result") {
      const id = Number(m.reqId);
      const p = pendingRes.get(id);
      if (!p) return;
      pendingRes.delete(id);
      if (m.ok) p.resolve(m.data);
      else p.reject(new Error(String(m.error ?? "resource error")));
    }
  });

  const post = (msg: Record<string, unknown>) => parent.postMessage(msg, "*");

  const host: Host = {
    save(content) {
      return new Promise((resolve, reject) => {
        if (pendingSave) {
          reject(new Error("save already in flight — await the previous save() first"));
          return;
        }
        pendingSave = { resolve, reject };
        post({ type: "cheers:save", content });
      });
    },
    resource<T>(name: string, params: Record<string, unknown> = {}) {
      return new Promise<T>((resolve, reject) => {
        const id = ++reqId;
        pendingRes.set(id, { resolve: resolve as (v: unknown) => void, reject });
        post({ type: "cheers:resource", reqId: id, resource: name, params });
      });
    },
    unsupported: (reason) => post({ type: "cheers:unsupported", reason }),
    open: (uri) => post({ type: "cheers:open", uri }),
    compose: (text) => post({ type: "cheers:compose", text }),
    log: (message, level = "info") =>
      post({ type: "cheers:log", level, message: String(message).slice(0, 2000) }),
  };

  // An opaque-origin sandbox swallows uncaught errors — forward them so a blank iframe
  // becomes a readable line in the host's inspector.
  window.addEventListener("error", (e) =>
    host.log(`uncaught: ${e.message} @${e.filename}:${e.lineno}`, "error")
  );
  window.addEventListener("unhandledrejection", (e) =>
    host.log(`unhandled rejection: ${String((e.reason as Error)?.message ?? e.reason)}`, "error")
  );

  post({ type: "cheers:ready" });
  return host;
}

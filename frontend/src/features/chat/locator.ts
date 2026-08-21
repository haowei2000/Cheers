// Cheers Locator — the textual, AI-writable serialization of the platform's existing
// {verb, params} resource addressing (design: docs/arch/CODEMAP.md §4). One token, no
// spaces, GitHub-style line anchors:
//
//   cheers:desk/<path>[#L<n>[-L<n>]]        this channel's Desk (context_files) file
//   cheers:ws/<bot>/<path>[#L<n>[-L<n>]]    a bot's real workspace file; <bot> is
//                                           "@handle" (member name) or a bot id
//   cheers:msg/<message_id>                 a message in this channel
//   cheers:inbox/<file_id>                  a chat attachment
//
// A locator is UI routing, not a data channel: resolving one ends in the existing
// jump surfaces (workbench deep-link, RemoteWorkspaceDialog, channel files view),
// and every actual read still passes the existing authz (fs.read channel-role,
// workspace.read owner grant + existence probe). Channel scope is implicit — always
// the current channel — matching how the host pins channel_id elsewhere.
//
// Parsing is strict on shape (a malformed locator returns null and the caller shows
// a clear error) but liberal on intent (a reversed line range is swapped, not
// rejected) — "strict generation, tolerant parsing".

export type Locator =
  | { kind: "desk"; path: string; line?: number; lineEnd?: number }
  | { kind: "ws"; bot: string; path: string; line?: number; lineEnd?: number }
  | { kind: "msg"; messageId: string }
  | { kind: "inbox"; fileId: string }
  // Channel-scoped projections: no tail, no anchor — the channel IS the address.
  | { kind: "plan" | "sessions" | "cost" | "activity" };

/** The projections addressed by a bare `cheers:<kind>`. */
const CHANNEL_KINDS = ["plan", "sessions", "cost", "activity"] as const;
type ChannelKind = (typeof CHANNEL_KINDS)[number];

function isChannelKind(value: string): value is ChannelKind {
  return (CHANNEL_KINDS as readonly string[]).includes(value);
}

export const LOCATOR_SCHEME = "cheers:";
/** Sanity cap for locators arriving from sandboxed plugins (a path plus an anchor —
 *  anything longer is garbage or an attack surface, not a file reference). */
export const MAX_LOCATOR_LENGTH = 2048;

// One path segment of hygiene: locators address files RELATIVELY. Absolute paths and
// dot-segments never appear in honest locators; rejecting them here means no consumer
// (workbench focus, workspace probe) ever sees a traversal attempt.
function cleanRelPath(p: string): string | null {
  if (!p || p.startsWith("/") || p.includes("\\")) return null;
  const segs = p.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
  return p;
}

function parseAnchor(frag: string): { line: number; lineEnd?: number } | null {
  const m = frag.match(/^L(\d+)(?:-L(\d+))?$/);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = m[2] !== undefined ? parseInt(m[2], 10) : undefined;
  if (!Number.isFinite(a) || a < 1) return null;
  if (b === undefined) return { line: a };
  if (!Number.isFinite(b) || b < 1) return null;
  // tolerant on intent: a reversed range still names the same lines
  return b < a ? { line: b, lineEnd: a } : { line: a, lineEnd: b };
}

/** Parse a `cheers:` locator. Returns null when the uri is not a well-formed locator —
 *  callers surface that as a user-visible error, never as silence. */
export function parseLocator(uri: string): Locator | null {
  if (typeof uri !== "string") return null;
  if (uri.length > MAX_LOCATOR_LENGTH) return null;
  if (!uri.startsWith(LOCATOR_SCHEME)) return null;
  // single-token by design: whitespace/control chars can't appear in a valid locator
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(uri)) return null;

  const rest = uri.slice(LOCATOR_SCHEME.length);
  const hash = rest.indexOf("#");
  const body = hash < 0 ? rest : rest.slice(0, hash);
  const frag = hash < 0 ? null : rest.slice(hash + 1);

  // A leading slash means an authority form (`cheers://…`) — a deep link, not a
  // locator. No slash at all is a channel-scoped kind.
  const slash = body.indexOf("/");
  if (slash === 0) return null;
  const scheme = slash < 0 ? body : body.slice(0, slash);
  const tail = slash < 0 ? "" : body.slice(slash + 1);

  let anchor: { line: number; lineEnd?: number } | null = null;
  if (frag !== null) {
    anchor = parseAnchor(frag);
    if (!anchor) return null; // a fragment that isn't a line anchor is a malformed locator
  }

  if (scheme === "desk") {
    const path = cleanRelPath(tail);
    if (!path) return null;
    return { kind: "desk", path, ...(anchor ?? {}) };
  }
  if (scheme === "ws") {
    const slash2 = tail.indexOf("/");
    if (slash2 <= 0) return null;
    const bot = tail.slice(0, slash2);
    const path = cleanRelPath(tail.slice(slash2 + 1));
    if (!path || bot === "@") return null;
    return { kind: "ws", bot, path, ...(anchor ?? {}) };
  }
  if (scheme === "msg") {
    if (!tail || tail.includes("/") || anchor) return null;
    return { kind: "msg", messageId: tail };
  }
  if (scheme === "inbox") {
    if (!tail || tail.includes("/") || anchor) return null;
    return { kind: "inbox", fileId: tail };
  }
  if (isChannelKind(scheme)) {
    if (tail || anchor) return null;
    return { kind: scheme };
  }
  return null;
}

function anchorSuffix(line?: number, lineEnd?: number): string {
  if (line === undefined) return "";
  return lineEnd === undefined ? `#L${line}` : `#L${line}-L${lineEnd}`;
}

/** Render a locator back to its URI.
 *
 * The half this module never had. Without it a resource could be read from text an agent
 * wrote but never named in text the UI produces — so "copy a link to this" could not
 * exist, and every surface hand-rolled its own reference instead.
 *
 * Mirrored by `format` in packages/cheers-mcp-server/src/locator.rs; both are pinned to
 * fixtures/locator/corpus.json so the two cannot drift. */
export function formatLocator(loc: Locator): string {
  switch (loc.kind) {
    case "desk":
      return `${LOCATOR_SCHEME}desk/${loc.path}${anchorSuffix(loc.line, loc.lineEnd)}`;
    case "ws":
      return `${LOCATOR_SCHEME}ws/${loc.bot}/${loc.path}${anchorSuffix(loc.line, loc.lineEnd)}`;
    case "msg":
      return `${LOCATOR_SCHEME}msg/${loc.messageId}`;
    case "inbox":
      return `${LOCATOR_SCHEME}inbox/${loc.fileId}`;
    default:
      return `${LOCATOR_SCHEME}${loc.kind}`;
  }
}

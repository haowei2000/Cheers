// Human-readable session labels. docs/arch/SESSION_MODEL.md deliberately gives sessions
// no stored title, so the UI derives one from what a session already carries: the primary
// session reads as "primary"; an extra ("other") session is named by its working-directory
// basename when it has one (coding sessions), else a short timestamp, else the short id —
// anything but a raw 36-char uuid. Callers prepend the bot name where the bot isn't already
// obvious from context (e.g. a <select> optgroup already grouped by bot).

/** Last path segment of an absolute cwd, e.g. "/srv/app/frontend" → "frontend". */
export function cwdBasename(cwd?: string | null): string | null {
  if (!cwd) return null;
  const seg = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return seg ? seg : null;
}

/** Compact local timestamp, e.g. "Jul 7 14:30" (null on missing/invalid). */
export function shortWhen(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A readable distinguisher for one session: "primary" for the primary, else the
 *  working-dir basename → a short timestamp → the short id (never a full uuid). */
export function sessionTag(s: {
  is_primary: boolean;
  session_id: string;
  /** ACP working directory (metadata.workspace.cwd), when the session has one. */
  cwd?: string | null;
  /** created_at (preferred) or last_used_at, used only when there's no cwd. */
  when?: string | null;
}): string {
  if (s.is_primary) return "primary";
  return cwdBasename(s.cwd) ?? shortWhen(s.when) ?? s.session_id.slice(0, 8);
}

/** Session status → text/icon color (shared by the Sessions board and the
 *  composer's session chip so the same status never renders two colors). */
export function statusColor(s: string): string {
  switch (s) {
    case "active":
    case "busy":
      return "text-emerald-500";
    case "idle":
      return "text-zinc-500";
    case "paused":
      return "text-amber-400";
    case "error":
    case "revoked":
    case "expired":
      return "text-red-400";
    default:
      return "text-zinc-500";
  }
}

/** Session status → solid dot fill (bg-*), for plain status dots (DESIGN.md §2.7 shape). */
export function statusDotColor(s: string): string {
  switch (s) {
    case "active":
    case "busy":
      return "bg-emerald-500";
    case "idle":
      return "bg-zinc-600";
    case "paused":
      return "bg-amber-400";
    case "error":
    case "revoked":
    case "expired":
      return "bg-red-400";
    default:
      return "bg-zinc-600";
  }
}

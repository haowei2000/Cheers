import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Copy, Hash, Link2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  createInviteLink,
  inviteUrl,
  listInviteLinks,
  revokeInviteLink,
  type InviteLink,
} from "@/api/invites";

// Anyone with the URL can join, so the options deliberately nudge toward
// bounded links; "" encodes never/unlimited (backend: omitted field).
const EXPIRY_OPTIONS = [
  { label: "Expires in 1 day", hours: 24 },
  { label: "Expires in 7 days", hours: 24 * 7 },
  { label: "Expires in 30 days", hours: 24 * 30 },
  { label: "Never expires", hours: "" },
] as const;
const USES_OPTIONS = [
  { label: "Unlimited uses", uses: "" },
  { label: "1 use", uses: 1 },
  { label: "5 uses", uses: 5 },
  { label: "25 uses", uses: 25 },
  { label: "100 uses", uses: 100 },
] as const;

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context; fall back to the legacy path.
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast.success("Invite link copied");
}

/** "2026-07-17 12:34:56.78+00" (pg ::text) → short local date, best-effort.
 *  `Date` won't parse pg's bare "+00" zone suffix — pad it to "+00:00". */
function shortDate(ts: string | null): string | null {
  if (!ts) return null;
  let iso = ts.replace(" ", "T");
  if (/[+-]\d{2}$/.test(iso)) iso = `${iso}:00`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

// Shareable invite-link manager (workspace admins; the backend 403s everyone
// else — the caller gates rendering). With `channelId` it mints links scoped to
// that public channel and lists only those; without, plain workspace links.
export function InviteLinksSection({
  workspaceId,
  channelId,
}: {
  workspaceId: string;
  channelId?: string;
}) {
  const [links, setLinks] = useState<InviteLink[]>([]);
  const [allowed, setAllowed] = useState(true);
  const [expiry, setExpiry] = useState<string>(String(24 * 7));
  const [uses, setUses] = useState<string>("");
  const [creating, setCreating] = useState(false);

  async function refresh() {
    try {
      const all = await listInviteLinks(workspaceId);
      setLinks(channelId ? all.filter((l) => l.channel_id === channelId) : all);
      setAllowed(true);
    } catch {
      // Not a workspace admin (or workspace gone) — hide the section.
      setAllowed(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [workspaceId, channelId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function create() {
    setCreating(true);
    try {
      const link = await createInviteLink(workspaceId, {
        expires_in_hours: expiry === "" ? null : Number(expiry),
        max_uses: uses === "" ? null : Number(uses),
        channel_id: channelId ?? null,
      });
      await copyToClipboard(inviteUrl(link.token));
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create link");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(link: InviteLink) {
    try {
      await revokeInviteLink(workspaceId, link.link_id);
      toast.success("Invite link revoked");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to revoke");
    }
  }

  if (!allowed) return null;

  const selectCls =
    "bg-zinc-800 rounded px-1.5 py-1 text-xs text-zinc-300 focus:outline-none focus:ring-2 focus:ring-indigo-500";

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
        Invite links
      </label>
      <p className="text-xs text-zinc-400">
        Anyone with a link can join{channelId ? " and lands in this channel" : ""} — no
        account needed yet. Revoke a link to stop it working.
      </p>

      <div className="flex items-center gap-2">
        <select value={expiry} onChange={(e) => setExpiry(e.target.value)} className={selectCls}>
          {EXPIRY_OPTIONS.map((o) => (
            <option key={o.label} value={String(o.hours)}>
              {o.label}
            </option>
          ))}
        </select>
        <select value={uses} onChange={(e) => setUses(e.target.value)} className={selectCls}>
          {USES_OPTIONS.map((o) => (
            <option key={o.label} value={String(o.uses)}>
              {o.label}
            </option>
          ))}
        </select>
        <Button size="sm" loading={creating} onClick={() => void create()}>
          <Link2 className="w-3.5 h-3.5" />
          Create link
        </Button>
      </div>

      {links.length > 0 && (
        <div className="rounded-lg bg-zinc-950/40 divide-y divide-zinc-800/60">
          {links.map((l) => {
            const dead = l.status !== "active";
            return (
              <div key={l.link_id} className="flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-mono text-zinc-300 truncate">
                    {inviteUrl(l.token)}
                  </p>
                  <p className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                    {l.channel_name && !channelId && (
                      <span className="inline-flex items-center gap-0.5">
                        <Hash className="w-3 h-3" />
                        {l.channel_name}
                      </span>
                    )}
                    <span>
                      {l.use_count}
                      {l.max_uses != null ? `/${l.max_uses}` : ""} used
                    </span>
                    <span>·</span>
                    <span>
                      {l.expires_at
                        ? `expires ${shortDate(l.expires_at) ?? l.expires_at.slice(0, 10)}`
                        : "never expires"}
                    </span>
                    {dead && (
                      <span className="text-amber-400">
                        · {l.status === "expired" ? "expired" : "used up"}
                      </span>
                    )}
                  </p>
                </div>
                {!dead && (
                  <button
                    onClick={() => void copyToClipboard(inviteUrl(l.token))}
                    title="Copy invite link"
                    className="text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded p-1"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                )}
                <button
                  onClick={() => void revoke(l)}
                  title="Revoke link"
                  className="text-zinc-500 hover:text-red-400 hover:bg-zinc-800 rounded p-1"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

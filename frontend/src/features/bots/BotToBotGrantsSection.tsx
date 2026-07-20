import { useCallback, useEffect, useMemo, useState } from "react";
import { notify, messageOf } from "@/lib/notify";
import { X, Plus } from "lucide-react";
import {
  getBotGrants,
  upsertBotGrant,
  deleteBotGrant,
  type BotGrants,
  type BotGrant,
  type BotGrantKind,
} from "@/api/bots";

// Bot-to-bot grants (docs/design/RESOURCE_CONTEXT.md §4, docs/design/BOT_DISPATCH.md D2):
// the dedicated surface for grants keyed on ANOTHER bot as subject — which bot may
// command this one (dispatch) and which may read its workspace (workspace_read). Both
// default member-allow, so this list is normally empty and the section exists to author
// DENY overrides (or re-allow a bot you denied). Distinct from the human INITIATE/SEE/
// RESPOND matrix, which is keyed on channel role / user / group.

const GRANT_BADGE: Record<BotGrantKind, string> = {
  dispatch: "bg-sky-950/60 border-sky-900 text-sky-200",
  workspace_read: "bg-violet-950/50 border-violet-900 text-violet-200",
};

// v1 scope: the form authors BOT-WIDE grants (the dominant case — "bot X may not read
// my workspace / command me, anywhere"). Rules that carry a channel scope (authored via
// the API) still render in the list; per-channel authoring in the UI is a later refinement.

export function BotToBotGrantsSection({ botId }: { botId: string }) {
  const [data, setData] = useState<BotGrants | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // new-grant draft
  const [grant, setGrant] = useState<BotGrantKind>("workspace_read");
  const [subjectId, setSubjectId] = useState(""); // bot_id | "*"
  const [decision, setDecision] = useState<"allow" | "deny">("deny");
  const [expiry, setExpiry] = useState(""); // seconds until expiry ("" = permanent)

  const load = useCallback(async () => {
    try {
      setData(await getBotGrants(botId));
    } catch (e) {
      notify.error(messageOf(e));
    }
  }, [botId]);
  useEffect(() => {
    load();
  }, [load]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
      await load();
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  const kindLabel = useMemo(() => {
    const m: Record<string, string> = {};
    for (const k of data?.grant_kinds ?? []) m[k.kind] = k.label;
    return m;
  }, [data]);
  // Raw (event_class · capability) key per grant kind — shown only in hover tooltips,
  // never as the default label. Falls back to the raw kind id if the backend omits it.
  const kindTech = useMemo(() => {
    const m: Record<string, string> = {};
    for (const k of data?.grant_kinds ?? []) m[k.kind] = k.tech || k.kind;
    return m;
  }, [data]);
  const subjectLabel = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of data?.subjects ?? []) m[s.bot_id] = s.label;
    return m;
  }, [data]);

  const resetDraft = () => {
    setCreating(false);
    setGrant("workspace_read");
    setSubjectId("");
    setDecision("deny");
    setExpiry("");
  };

  if (!data) {
    return <p className="text-xs text-zinc-400 px-1 py-2">Loading bot-to-bot grants…</p>;
  }

  const grants = data.grants;

  return (
    <div className="rounded-xl bg-zinc-950/40 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <div>
          <p className="text-xs font-medium text-zinc-300">Bot-to-bot grants</p>
          <p className="text-[11px] text-zinc-400 mt-0.5">
            Which OTHER bots may command this bot (dispatch) or read its workspace files
            (workspace read). Both default to <span className="text-emerald-300">allowed</span> for
            any bot you share a channel with — add a rule here to deny a specific bot (or “∗ any
            bot”), or to re-allow one you denied. Precedence: specific bot ▸ ∗; deny wins ties.
          </p>
        </div>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="ml-auto inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-500"
          >
            <Plus className="w-3.5 h-3.5" />
            New rule
          </button>
        )}
      </div>

      {creating && (
        <div className="space-y-1.5 rounded-lg bg-zinc-900/40 p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              value={grant}
              onChange={(e) => setGrant(e.target.value as BotGrantKind)}
              className="rounded-md bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300"
            >
              {data.grant_kinds.map((k) => (
                <option key={k.kind} value={k.kind} title={`${k.kind} — ${k.tech}`}>
                  {k.label}
                </option>
              ))}
            </select>
            <select
              value={subjectId}
              onChange={(e) => setSubjectId(e.target.value)}
              className="rounded-md bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300"
            >
              <option value="">which bot…</option>
              <option value="*">∗ any bot</option>
              {data.subjects.length > 0 && (
                <optgroup label="Bots in shared channels">
                  {data.subjects.map((s) => (
                    <option key={s.bot_id} value={s.bot_id}>
                      {s.label}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <select
              value={decision}
              onChange={(e) => setDecision(e.target.value as "allow" | "deny")}
              className="rounded-md bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300"
            >
              <option value="deny">deny</option>
              <option value="allow">allow</option>
            </select>
            <select
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              title="Time-box the rule: past the expiry it stops applying (listed as expired until deleted)"
              className="rounded-md bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300"
            >
              <option value="">permanent</option>
              <option value="3600">for 1 hour</option>
              <option value="28800">for 8 hours</option>
              <option value="86400">for 1 day</option>
              <option value="604800">for 7 days</option>
              <option value="2592000">for 30 days</option>
            </select>
            <button
              type="button"
              disabled={!subjectId || busy !== null}
              onClick={() =>
                run("add", async () => {
                  await upsertBotGrant(botId, {
                    subject_id: subjectId,
                    grant,
                    decision,
                    expires_at: expiry
                      ? new Date(Date.now() + Number(expiry) * 1000).toISOString()
                      : undefined,
                  });
                  resetDraft();
                })
              }
              className="rounded-md bg-indigo-600 px-2 py-0.5 text-[11px] text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              Create
            </button>
            <button
              type="button"
              onClick={resetDraft}
              className="rounded-md bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
            >
              Cancel
            </button>
          </div>
          <p className="text-[11px] text-zinc-400">
            Applies bot-wide (all channels). A concrete bot must be one you share a channel with.
          </p>
        </div>
      )}

      {grants.length === 0 ? (
        <p className="text-[11px] text-zinc-400">
          No rules — every bot you share a channel with may command this bot and read its workspace
          (the member-allow default). Click “New rule” to deny a specific bot.
        </p>
      ) : (
        <div className="space-y-1.5">
          {grants.map((r: BotGrant) => (
            <div
              key={`${r.grant}:${r.channel_id}:${r.subject_id}`}
              className="flex items-center gap-2 rounded-md bg-zinc-950/30 px-2.5 py-2 text-[11px]"
            >
              <span
                className={`rounded px-1 py-0.5 text-[10px] border ${GRANT_BADGE[r.grant]}`}
                title={`${r.grant} — ${kindTech[r.grant] ?? r.grant}`}
              >
                {kindLabel[r.grant] ?? r.grant}
              </span>
              <span className="text-zinc-600">→</span>
              <span className="text-zinc-200" title={r.subject_id}>
                {r.subject_id === "*"
                  ? "∗ any bot"
                  : subjectLabel[r.subject_id] || `${r.subject_id.slice(0, 8)}…`}
              </span>
              <span className="text-zinc-600">·</span>
              <span className="text-zinc-400" title={r.channel_id || undefined}>
                {r.channel_id ? `#${r.channel_id.slice(0, 8)}` : "Bot-wide"}
              </span>
              {r.expired ? (
                <span
                  className="rounded px-1 py-0.5 text-[10px] text-zinc-400"
                  title={`Expired ${r.expires_at ? new Date(r.expires_at).toLocaleString() : ""} — no longer enforced; delete or re-create to renew`}
                >
                  expired
                </span>
              ) : r.expires_at ? (
                <span className="text-amber-400/80 text-[10px]" title={new Date(r.expires_at).toLocaleString()}>
                  until {new Date(r.expires_at).toLocaleDateString()}{" "}
                  {new Date(r.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              ) : null}
              <span
                className={`ml-auto ${
                  r.expired
                    ? "text-zinc-400 line-through"
                    : r.decision === "allow"
                      ? "text-emerald-300"
                      : "text-red-300"
                }`}
              >
                {r.decision}
              </span>
              <button
                type="button"
                title="Remove this rule (back to the member-allow default)"
                disabled={busy !== null}
                onClick={() =>
                  run(`rm:${r.grant}:${r.channel_id}:${r.subject_id}`, () =>
                    deleteBotGrant(botId, {
                      channel_id: r.channel_id || undefined,
                      subject_id: r.subject_id,
                      grant: r.grant,
                    })
                  )
                }
                className="text-zinc-500 hover:text-red-300 disabled:opacity-40"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

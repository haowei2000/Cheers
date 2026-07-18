import { useCallback, useEffect, useState } from "react";
import { ArrowUpCircle } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { invokeDesktop } from "@/lib/desktop";
import { checkAgentUpdates, type AgentUpdate } from "@/lib/desktopConnector";

/** Onboarding banner: if any installed ACP adapter npm package is behind its
 *  latest published version, offer a one-click "Upgrade all" (a reinstall via
 *  the existing `install_agent`). Renders nothing while loading or when every
 *  adapter is current, so it stays out of the way in the common case. */
export function AgentUpdates() {
  const [updates, setUpdates] = useState<AgentUpdate[] | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    try {
      setUpdates(await checkAgentUpdates());
    } catch {
      setUpdates([]);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  if (updates === null) return null;
  const outdated = updates.filter((u) => u.outdated);
  if (outdated.length === 0) return null;

  async function upgradeAll() {
    setBusy(true);
    try {
      for (const u of outdated) {
        try {
          await invokeDesktop("install_agent", { key: u.key });
          toast.success(`Upgraded ${u.label}`);
        } catch (e) {
          toast.error(`${u.label}: ${typeof e === "string" ? e : "upgrade failed"}`);
        }
      }
      await check();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg bg-zinc-800/60 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <ArrowUpCircle className="w-4 h-4 text-indigo-400 shrink-0" />
        <p className="text-xs font-medium text-zinc-200">
          {outdated.length} adapter update{outdated.length > 1 ? "s" : ""} available
        </p>
        <button
          type="button"
          className="text-[11px] text-zinc-500 hover:text-zinc-300 ml-auto"
          onClick={() => void check()}
          disabled={busy}
        >
          Recheck
        </button>
      </div>
      <ul className="text-[11px] text-zinc-400 space-y-0.5">
        {outdated.map((u) => (
          <li key={u.key} className="flex items-center gap-1.5">
            <span className="text-zinc-300">{u.label}</span>
            <span className="tabular-nums">
              {u.installed ?? "?"} → {u.latest ?? "?"}
            </span>
          </li>
        ))}
      </ul>
      <Button variant="secondary" size="sm" loading={busy} onClick={() => void upgradeAll()}>
        <ArrowUpCircle className="w-3.5 h-3.5" /> Upgrade all
      </Button>
    </div>
  );
}

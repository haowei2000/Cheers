// Desktop-only: keep the macOS tray menu + dock badge in step with fleet
// liveness. No-op in the browser (every path is guarded on isTauri()), so web
// behaviour is unchanged. Mounted in the always-present ChatLayout.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { getFleet, getFleetBadge } from "@/api/fleet";
import { trayUpdateLiveness, type TrayAgent } from "@/lib/desktopApproval";
import { isTauri } from "@/lib/serverConfig";
import type { Channel } from "@/types";

/**
 * Derives the desktop liveness numbers and pushes them to the native shell:
 *   - unread  = sum of loaded channel unread counts (active workspace + DMs;
 *               no global-unread aggregate exists yet, so this under-counts
 *               unloaded workspaces — acceptable, matches the sidebar).
 *   - pending = global count of pending approvals the caller may answer
 *               (GET /fleet/badge), workspace-agnostic.
 *   - agents  = the active workspace's bot roster (busy = has a live session).
 *
 * Refreshed on mount, every 30s, on window focus, and whenever the active
 * workspace or the loaded channels change. A cheap signature gate skips the
 * IPC when nothing changed, so an open tray menu doesn't flicker.
 */
export function useTrayLiveness(
  selectedWorkspaceId: string | null,
  channels: Channel[]
): void {
  const unread = useMemo(
    () => channels.reduce((sum, c) => sum + (c.unread_count ?? 0), 0),
    [channels]
  );
  const lastSig = useRef<string>("");

  const push = useCallback(async () => {
    if (!isTauri()) return;
    let pending = 0;
    let agents: TrayAgent[] = [];
    // Both endpoints are best-effort: a fleet fetch failure must not wedge the
    // badge (fall back to whatever we could read).
    const [badge, fleet] = await Promise.all([
      getFleetBadge().catch(() => null),
      selectedWorkspaceId
        ? getFleet(selectedWorkspaceId).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (badge) pending = badge.count;
    if (fleet) {
      agents = fleet.bots.map((b) => ({
        name: b.bot_name,
        busy: b.busy_sessions > 0,
      }));
    }

    const sig =
      `${unread}|${pending}|` +
      agents.map((a) => `${a.name}:${a.busy ? 1 : 0}`).join(",");
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    await trayUpdateLiveness(unread, pending, agents);
  }, [unread, selectedWorkspaceId]);

  useEffect(() => {
    if (!isTauri()) return;
    void push();
    const id = window.setInterval(() => void push(), 30_000);
    const onFocus = () => void push();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [push]);
}

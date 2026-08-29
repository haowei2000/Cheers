import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getOccupant, SPAWN_KINDS, type Rect, type SpawnKind } from "@/features/chat/workbench/laneSnap";
import { makeFsClient, type SendResourceReq } from "@/features/chat/workbench/fsClient";
import { WORKBENCH_CONFIG_PATH } from "@/features/chat/workbench/environmentRegistry";
import { ResourceError } from "@/features/chat/hooks/useChatRealtime";
import {
  hasLocalOverride,
  mergeLayout,
  parseLayout,
  requestLayoutReset,
  storageKeyFor,
  subscribeLayoutOverride,
  toFraction,
  toLaneRect,
  type SharedLayout,
} from "@/features/chat/workbench/sharedLayout";

// The provider behind SharedLayoutContext: the channel's window arrangement, read from
// and written to `.workbench.json` under the existing `fs.*` verbs.
//
// No server change was needed for the agent half of this. `.workbench.json` is an
// ordinary channel file, so a bot with channel-role write access could always edit it —
// what was missing is that the client kept geometry in localStorage and never looked.
//
// This hook touches ONLY the `layout` key of that file. It reads and writes the raw
// document rather than going through `parseCfg`, whose known-keys parse would drop
// everything the Workbench drawer owns.

export interface ChannelLayout {
  /** This window's shared placement in lane pixels, or null when there is none. */
  geomFor: (kind: SpawnKind) => Rect | null;
  /** Windows the channel's layout asks to have open. */
  sharedOpen: Partial<Record<SpawnKind, boolean>>;
  /** Publish this viewer's current arrangement as the channel's, and drop their
   *  local overrides so they are following what they just saved. */
  saveLayout: (open: Record<SpawnKind, boolean>) => Promise<void>;
  /** Drop this device's overrides and follow the channel again. */
  resetLayout: () => void;
  /** True while at least one window has a local override — the only state in which
   *  "reset" means anything to the viewer. */
  overridden: boolean;
  saving: boolean;
  error: string | null;
}

export function useChannelLayout({
  channelId,
  sendResourceReq,
  getLaneBounds,
  enabled,
  filesTick,
}: {
  channelId: string;
  sendResourceReq: SendResourceReq;
  getLaneBounds: () => DOMRect | null;
  /** False on mobile, where windows are full-screen sheets and have no geometry. */
  enabled: boolean;
  /** Live push: a bot wrote to the channel workspace — re-read, in case it was this. */
  filesTick?: number;
}): ChannelLayout {
  const [shared, setShared] = useState<SharedLayout | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const overridden = useSyncExternalStore(subscribeLayoutOverride, hasLocalOverride, () => false);
  const fs = useMemo(() => makeFsClient(sendResourceReq, channelId), [sendResourceReq, channelId]);
  const fsRef = useRef(fs);
  fsRef.current = fs;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const file = await fsRef.current.read(WORKBENCH_CONFIG_PATH);
        const raw = JSON.parse(file.content) as { layout?: unknown };
        if (!cancelled) setShared(parseLayout(raw.layout));
      } catch {
        // No config yet, or unreadable: the channel simply has no shared layout and
        // every window falls back to its spawn placement.
        if (!cancelled) setShared(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId, enabled, filesTick]);

  const geomFor = useCallback(
    (kind: SpawnKind): Rect | null => {
      const rect = shared?.panels[kind]?.rect;
      if (!rect) return null;
      const bounds = getLaneBounds();
      // Before the lane has measured, a fraction resolves to a zero-size window. Report
      // nothing and let the next render — the lane element mounting is a state change —
      // ask again.
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
      return toLaneRect(rect, bounds);
    },
    [shared, getLaneBounds]
  );

  const sharedOpen = useMemo(() => {
    const open: Partial<Record<SpawnKind, boolean>> = {};
    for (const kind of SPAWN_KINDS) {
      const declared = shared?.panels[kind]?.open;
      if (declared !== undefined) open[kind] = declared;
    }
    return open;
  }, [shared]);

  const saveLayout = useCallback(
    async (open: Record<SpawnKind, boolean>) => {
      const bounds = getLaneBounds();
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
      setSaving(true);
      setError(null);
      const ours: SharedLayout = { version: 1, panels: {} };
      for (const kind of SPAWN_KINDS) {
        const rect = getOccupant(storageKeyFor(kind));
        const fraction = rect ? toFraction(rect, bounds) : null;
        ours.panels[kind] = fraction ? { rect: fraction, open: open[kind] } : { open: open[kind] };
      }

      // One merge-and-retry is enough because a drag never writes here: the only writers
      // are a human pressing Save and an agent, so a collision is rare and a second one
      // is not worth a backoff. Merging is per WINDOW, so a teammate who saved a
      // different window keeps their change.
      const attempt = async () => {
        let document: Record<string, unknown> = {};
        let version = 0;
        try {
          const file = await fsRef.current.read(WORKBENCH_CONFIG_PATH);
          document = JSON.parse(file.content) as Record<string, unknown>;
          version = file.version;
        } catch {
          /* no config yet — if_version 0 creates it */
        }
        const merged = mergeLayout(parseLayout(document.layout), ours);
        document.layout = merged;
        await fsRef.current.write(WORKBENCH_CONFIG_PATH, JSON.stringify(document, null, 2), version);
        return merged;
      };

      try {
        let merged: SharedLayout;
        try {
          merged = await attempt();
        } catch (e) {
          if (!(e instanceof ResourceError && e.code === "VERSION_CONFLICT")) throw e;
          merged = await attempt();
        }
        setShared(merged);
        // The viewer is now following exactly what they published, so their overrides
        // would only be a way to drift back out of sync with themselves.
        requestLayoutReset();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [getLaneBounds]
  );

  const resetLayout = useCallback(requestLayoutReset, []);

  return { geomFor, sharedOpen, saveLayout, resetLayout, overridden, saving, error };
}

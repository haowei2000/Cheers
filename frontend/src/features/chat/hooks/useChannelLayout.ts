import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { SPAWN_KINDS, type Rect, type SpawnKind } from "@/features/chat/workbench/laneSnap";
import { makeFsClient, type FsClient, type SendResourceReq } from "@/features/chat/workbench/fsClient";
import { WORKBENCH_CONFIG_PATH } from "@/features/chat/workbench/environmentRegistry";
import { ResourceError } from "@/features/chat/hooks/useChatRealtime";
import {
  hasLocalOverride,
  mergeLayout,
  parseLayout,
  requestLayoutReset,
  subscribeLayoutOverride,
  toFraction,
  toLaneRect,
  type SharedLayout,
  type SharedWorkspaceLayout,
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
  workspace: SharedWorkspaceLayout | undefined;
  /** Windows the channel's layout asks to have open. */
  sharedOpen: Partial<Record<SpawnKind, boolean>>;
  /** Publish this viewer's current arrangement as the channel's, and drop their
   *  local overrides so they are following what they just saved. */
  saveLayout: (
    open: Record<SpawnKind, boolean>,
    workspace?: SharedWorkspaceLayout,
    floatingPanels?: Partial<Record<SpawnKind, Rect>>,
  ) => Promise<void>;
  /** Drop this device's overrides and follow the channel again. */
  resetLayout: () => void;
  /** True while at least one window has a local override — the only state in which
   *  "reset" means anything to the viewer. */
  overridden: boolean;
  saving: boolean;
  error: string | null;
}

interface ChannelLayoutState {
  channelId: string;
  layout: SharedLayout | undefined;
}

export function layoutForChannel(
  state: ChannelLayoutState | undefined,
  channelId: string,
  enabled: boolean,
): SharedLayout | undefined {
  return enabled && state?.channelId === channelId ? state.layout : undefined;
}

/** Commit through one captured client so a channel switch cannot split a read/write
 * transaction across two channel workspaces. */
export async function commitSharedLayout(
  fs: Pick<FsClient, "read" | "write">,
  ours: SharedLayout,
): Promise<SharedLayout> {
  const attempt = async () => {
    let document: Record<string, unknown> = {};
    let version = 0;
    try {
      const file = await fs.read(WORKBENCH_CONFIG_PATH);
      document = JSON.parse(file.content) as Record<string, unknown>;
      version = file.version;
    } catch {
      /* no config yet — if_version 0 creates it */
    }
    const merged = mergeLayout(parseLayout(document.layout), ours);
    document.layout = merged;
    await fs.write(WORKBENCH_CONFIG_PATH, JSON.stringify(document, null, 2), version);
    return merged;
  };

  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof ResourceError && error.code === "VERSION_CONFLICT")) throw error;
    return attempt();
  }
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
  const [sharedState, setSharedState] = useState<ChannelLayoutState>();
  const [saveStatus, setSaveStatus] = useState<{
    channelId: string;
    saving: boolean;
    error: string | null;
  }>();
  const overridden = useSyncExternalStore(subscribeLayoutOverride, hasLocalOverride, () => false);
  const fs = useMemo(() => makeFsClient(sendResourceReq, channelId), [sendResourceReq, channelId]);
  const channelRef = useRef(channelId);
  channelRef.current = channelId;
  // Never expose the previous channel's value during the render before the new
  // channel's asynchronous read finishes.
  const shared = layoutForChannel(sharedState, channelId, enabled);
  const currentSaveStatus = saveStatus?.channelId === channelId ? saveStatus : undefined;
  const saving = currentSaveStatus?.saving ?? false;
  const error = currentSaveStatus?.error ?? null;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const file = await fs.read(WORKBENCH_CONFIG_PATH);
        const raw = JSON.parse(file.content) as { layout?: unknown };
        if (!cancelled) setSharedState({ channelId, layout: parseLayout(raw.layout) });
      } catch {
        // No config yet, or unreadable: the channel simply has no shared layout and
        // every window falls back to its spawn placement.
        if (!cancelled) setSharedState({ channelId, layout: undefined });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId, enabled, filesTick, fs]);

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
    async (
      open: Record<SpawnKind, boolean>,
      workspace?: SharedWorkspaceLayout,
      floatingPanels: Partial<Record<SpawnKind, Rect>> = {},
    ) => {
      // Geometry and the workspace preference are independent halves of an arrangement,
      // so neither gates the other. A docked viewer has a workspace block but no lane to
      // measure against; a viewer who floated a window has geometry whether or not the
      // workspace half came along. Save whichever halves this viewer actually has, and
      // bail only when there is no arrangement at all.
      const measured = getLaneBounds();
      const bounds = measured && measured.width > 0 && measured.height > 0 ? measured : null;
      if (!workspace && !bounds) return;
      const transactionChannel = channelId;
      const transactionFs = fs;
      setSaveStatus({ channelId: transactionChannel, saving: true, error: null });
      const ours: SharedLayout = { version: 1, panels: {}, ...(workspace ? { workspace } : {}) };
      for (const kind of SPAWN_KINDS) {
        const rect = floatingPanels[kind];
        const fraction = rect && bounds ? toFraction(rect, bounds) : null;
        // `null` explicitly removes a formerly-floating shared placement when this
        // viewer saves the panel docked. `mergeLayout` consumes the tombstone and
        // never writes it to the shared document.
        ours.panels[kind] = bounds
          ? { rect: fraction, open: open[kind] }
          : { open: open[kind] };
      }

      try {
        // One merge-and-retry is enough because a drag never writes here: the only
        // writers are an explicit human save and an agent write.
        const merged = await commitSharedLayout(transactionFs, ours);
        if (channelRef.current === transactionChannel) {
          setSharedState({ channelId: transactionChannel, layout: merged });
        }
        // The viewer is now following exactly what they published, so their overrides
        // would only be a way to drift back out of sync with themselves.
        if (channelRef.current === transactionChannel) requestLayoutReset();
      } catch (e) {
        if (channelRef.current === transactionChannel)
          setSaveStatus({
            channelId: transactionChannel,
            saving: false,
            error: e instanceof Error ? e.message : String(e),
          });
      } finally {
        if (channelRef.current === transactionChannel)
          setSaveStatus((current) => ({
            channelId: transactionChannel,
            saving: false,
            error: current?.channelId === transactionChannel ? current.error : null,
          }));
      }
    },
    [channelId, fs, getLaneBounds]
  );

  const resetLayout = useCallback(requestLayoutReset, []);

  return { workspace: shared?.workspace, geomFor, sharedOpen, saveLayout, resetLayout, overridden, saving, error };
}

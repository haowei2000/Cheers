import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { SPAWN_KINDS, type Rect, type SpawnKind } from "@/features/chat/workbench/laneSnap";
import { type FsClient, type SendResourceReq } from "@/features/chat/workbench/fsClient";
import { channelFileClient } from "@/features/chat/workbench/channelFileClient";
import { mutateWorkbenchConfiguration, useWorkbenchConfiguration } from "@/features/chat/workbench/workbenchConfiguration";
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
// This hook touches ONLY the `layout` key. Layout and drawer mutations share the
// same raw-document CAS transaction, so every owner preserves the other fields.

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
  let merged = ours;
  await mutateWorkbenchConfiguration(fs, (document) => {
    merged = mergeLayout(parseLayout(document.layout), ours);
    document.layout = merged;
  });
  return merged;
}

export function buildLayoutUpdate(
  open: Record<SpawnKind, boolean>,
  workspace: SharedWorkspaceLayout | undefined,
  floatingPanels: Partial<Record<SpawnKind, Rect>>,
  bounds: { width: number; height: number } | null,
): SharedLayout {
  const ours: SharedLayout = {
    version: 1,
    panels: {},
    ...(workspace ? { workspace } : {}),
  };
  for (const kind of SPAWN_KINDS) {
    if (!bounds || !open[kind]) {
      // A closed panel has not been instantiated, so absence from `floatingPanels`
      // says nothing about whether its saved placement is docked or floating.
      ours.panels[kind] = { open: open[kind] };
      continue;
    }
    const rect = floatingPanels[kind];
    ours.panels[kind] = {
      rect: rect ? toFraction(rect, bounds) : null,
      open: true,
    };
  }
  return ours;
}

export function useChannelLayout({
  channelId,
  sendResourceReq,
  getLaneBounds,
  enabled,
  filesTick,
  fileClient,
}: {
  channelId: string;
  sendResourceReq: SendResourceReq;
  getLaneBounds: () => DOMRect | null;
  /** False on mobile, where windows are full-screen sheets and have no geometry. */
  enabled: boolean;
  /** Live push: a bot wrote to the channel workspace — re-read, in case it was this. */
  filesTick?: number;
  fileClient?: FsClient;
}): ChannelLayout {
  const [saveStatus, setSaveStatus] = useState<{
    channelId: string;
    saving: boolean;
    error: string | null;
  }>();
  const overridden = useSyncExternalStore(subscribeLayoutOverride, hasLocalOverride, () => false);
  const fs = useMemo(() => fileClient ?? channelFileClient(sendResourceReq, channelId), [fileClient, sendResourceReq, channelId]);
  const configuration = useWorkbenchConfiguration(fs, enabled, filesTick);
  const channelRef = useRef(channelId);
  channelRef.current = channelId;
  // Never expose the previous channel's value during the render before the new
  // channel's asynchronous read finishes.
  const shared = useMemo(() => enabled ? parseLayout(configuration.document?.layout) : undefined, [configuration.document, enabled]);
  const currentSaveStatus = saveStatus?.channelId === channelId ? saveStatus : undefined;
  const saving = currentSaveStatus?.saving ?? false;
  const error = currentSaveStatus?.error ?? null;

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
      // `null` explicitly removes a formerly-floating shared placement when a known
      // open panel is docked. Closed panels update visibility only.
      const ours = buildLayoutUpdate(open, workspace, floatingPanels, bounds);

      try {
        // One merge-and-retry is enough because a drag never writes here: the only
        // writers are an explicit human save and an agent write.
        await commitSharedLayout(transactionFs, ours);
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

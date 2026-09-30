import { useManagedPanel } from "@/components/ui/managed-panel";
import { ActionButton } from "@/components/ui/action-button";
import { Fragment, memo, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CollectionIcon } from "@/components/ui/editorial-icons";
import { Folder, Package } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { GlanceRow } from "@/components/ui/glance-row";
import { makeFsClient, type SendResourceReq } from "./fsClient";
import type { WorkbenchContext } from "./context";
import type { PresenceFocus } from "../hooks/useChatRealtime";
import { FilePanel } from "./panels/FilePanel";
import { SceneWorkbench } from "./SceneWorkbench";
import { useChannelProfile } from "@/hooks/useChannelProfile";
import { panelsFor, type PanelContext } from "@/features/chat/panels/registry";
import "@/features/chat/panels/builtin/githubCode";
import "./lens/builtins";
import { parseLocator } from "../locator";
import {
  appendCollectionTab,
  parseCfg,
  type WbConfig,
  type WorkbenchSceneState,
  WB_DOC,
} from "./workbenchConfig";
import { useWorkbenchDrawerState } from "./useWorkbenchDrawerState";

// Re-export configuration types and helpers for backward compatibility
export {
  appendCollectionTab,
  parseCfg,
  type WbConfig,
  type WorkbenchSceneState,
  WB_DOC,
};

interface Props {
  open: boolean;
  onClose: () => void;
  channelId: string;
  sendResourceReq: SendResourceReq;
  /** Deep-link: open the browser focused on this path (e.g. a clicked Desk ref). */
  openFilePath?: string;
  /** Live-push tick for the Desk ("files" board): bump → the browser re-pulls the
   *  tree and reloads a clean open file (unsaved edits are never clobbered). */
  filesTick?: number;
  /** Navigate the user's view to a `cheers:` locator (a personal renderer capability
   *  host API). Owned by ChannelView — it holds every jump surface (workspace dialog,
   *  channel files, this drawer's own deep-link). */
  onOpenLocator?: (uri: string) => void;
  /** Prefill the channel composer (a personal renderer capability).
   *  Never sends — owned by ChannelView, which holds the composer. */
  onCompose?: (text: string) => void;
  sendPresenceFocus?: (chanId: string, focus: { bot_id: string; path?: string | null } | null) => void;
  workspaceFocus?: PresenceFocus[];
  currentUserId?: string;
  memberNames?: Record<string, string> | ReadonlyMap<string, string>;
}

// Right-side per-channel workbench: scenes contain native content tabs; Raw is the
// explicit escape hatch to the complete file browser.
function WorkbenchDrawerImpl({
  open,
  onClose,
  channelId,
  sendResourceReq,
  openFilePath,
  filesTick,
  onOpenLocator,
  onCompose,
  sendPresenceFocus,
  workspaceFocus,
  currentUserId,
  memberNames,
}: Props) {
  const navigate = useNavigate();
  const fs = useMemo(() => makeFsClient(sendResourceReq, channelId), [sendResourceReq, channelId]);
  const profile = useChannelProfile(channelId, open);

  const drawerState = useWorkbenchDrawerState({
    open,
    channelId,
    fs,
    openFilePath,
  });

  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("cheers.float.workbench.min") === "1"
  );
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem("cheers.float.workbench.min", c ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !c;
    });
  };
  const managed = useManagedPanel("workbench");
  const minimized = collapsed && !isMobile && !managed;

  const ctx: WorkbenchContext = useMemo(
    () => ({
      active: open,
      channelId,
      profile,
      fs,
      sendResourceReq,
      pinned: drawerState.pinned,
      togglePin: drawerState.togglePin,
      rendererExtensions: drawerState.rendererExtensions,
      bindings: drawerState.bindings,
      setBinding: drawerState.setBinding,
      configs: drawerState.configs,
      openTarget: drawerState.focus,
      openInspectableId: (() => {
        const locator = openFilePath?.startsWith("cheers:") ? parseLocator(openFilePath) : null;
        return locator?.kind === "desk" && locator.path === drawerState.focus ? locator.inspectableId : undefined;
      })(),
      filesTick,
      openLocator: onOpenLocator,
      composeMessage: onCompose,
      sendPresenceFocus,
      workspaceFocus,
      currentUserId,
      memberNames,
    }),
    [
      open,
      channelId,
      profile,
      fs,
      sendResourceReq,
      drawerState.pinned,
      drawerState.togglePin,
      drawerState.rendererExtensions,
      drawerState.bindings,
      drawerState.setBinding,
      drawerState.configs,
      drawerState.focus,
      openFilePath,
      filesTick,
      onOpenLocator,
      onCompose,
      sendPresenceFocus,
      workspaceFocus,
      currentUserId,
      memberNames,
    ]
  );

  const profilePanels = panelsFor("inline", profile?.profile);
  const panelCtx: PanelContext = useMemo(
    () => ({
      channelId,
      profile,
      sendResourceReq,
      fs,
      visible: open,
      openLocator: onOpenLocator,
      composeMessage: onCompose,
    }),
    [channelId, profile, sendResourceReq, fs, open, onOpenLocator, onCompose]
  );

  return (
    <FloatingPanel
      title="Workbench"
      icon={Package}
      onClose={onClose}
      storageKey="cheers.float.workbench"
      open={open}
      collapsed={minimized}
      onToggleCollapsed={toggleCollapsed}
      spawnKind="workbench"
      className="w-[min(960px,calc(100vw-2rem))] h-[min(840px,88%)]"
      defaultPosClassName="top-2 left-2"
      bodyClassName="flex flex-col overflow-hidden p-0 space-y-0"
      primaryNavigation={drawerState.rawMode ? {
        ariaLabel: "Workbench Collections",
        presentationOrder: ["collapsed"],
        collapsedContent: "icon",
        items: [
          { id: "collections", label: "Back to Collections", icon: CollectionIcon, onSelect: () => drawerState.setRawMode(false) },
          { id: "raw-workspace-files", label: "Raw workspace files", icon: Folder, selected: true, onSelect: () => undefined },
        ],
      } : undefined}
      collapsedSummary={() => (
        <div className="min-h-0 overflow-y-auto overscroll-contain p-2">
          <GlanceRow
            Icon={Package}
            label="Collection"
            value={drawerState.allEnvs.find((e) => e.id === drawerState.selectedId)?.title ?? "General"}
            onClick={toggleCollapsed}
            title="Open workbench"
          />
        </div>
      )}
    >
      {drawerState.notice && (
        <div className="mx-2 mt-2 flex items-center gap-2 rounded-sm bg-amber-500/10 px-3 py-2 text-compact text-warning-400/90">
          <span className="flex-1">{drawerState.notice}</span>
          <ActionButton
            action="close"
            context="windowChrome"
            accessibleLabel="Dismiss notice"
            controlSize="compact"
            onClick={() => drawerState.setNotice(null)}
          />
        </div>
      )}

      {/* Content-first by default: Collection → Tab → renderer. Raw is an explicit
          mode that mounts the complete file tree and editor. */}
      <div className={minimized ? "hidden" : "flex min-h-0 flex-1 flex-col overflow-hidden"}>
        {open && profilePanels.map((panel) => <Fragment key={panel.id}>{panel.render(panelCtx)}</Fragment>)}
        <div className="min-h-0 flex-1 overflow-hidden">
          {open && (drawerState.rawMode ? (
            <FilePanel ctx={ctx} />
          ) : (
            <SceneWorkbench
              ctx={ctx}
              sceneState={drawerState.cfg.scene_state}
              legacyEnvironment={drawerState.cfg.environment}
              templates={drawerState.allEnvs}
              onAddScene={drawerState.activate}
              onAddTab={drawerState.addTab}
              onLoadCollection={() => navigate("/settings/workbench")}
              onShowRaw={() => drawerState.setRawMode(true)}
            />
          ))}
        </div>
      </div>
    </FloatingPanel>
  );
}

// Memoized: skips re-rendering the workbench on ChannelView's per-delta streaming renders
export const WorkbenchDrawer = memo(WorkbenchDrawerImpl);

import type { ReactNode } from "react";
import { ArrowLeft, Hash, Mail } from "lucide-react";
import { Button as UiButton } from "@/components/ui/button";
import { WindowChromeActions } from "@/features/desktop/WindowChromeActions";
import { useWindowChromePlacement } from "@/features/desktop/WindowChromeContext";
import { ChannelHeaderSlot } from "./extensions/ChannelHeaderSlot";
import { AdaptiveControlGroup } from "@/components/ui/adaptive-control-group";
import { LANE_WINDOWS } from "@/features/chat/panels/laneWindows";
import type { SpawnKind } from "./workbench/laneSnap";

export function ChannelPanelSwitcher({
  panels,
  activePanel,
  onSelect,
}: {
  panels: SpawnKind[];
  activePanel?: SpawnKind;
  onSelect: (id: SpawnKind) => void;
}) {
  const items = LANE_WINDOWS.filter((panel) => panels.includes(panel.id)).map((panel) => ({
    id: panel.id,
    label: panel.title,
    icon: panel.icon,
    selected: panel.id === activePanel,
    onSelect: () => onSelect(panel.id),
  }));
  if (!items.length) return null;

  return (
    <div className="min-w-0 max-w-[min(36vw,420px)] shrink">
      <AdaptiveControlGroup
        items={items}
        kind="navigation"
        ariaLabel="Open channel panels"
        controlSize="compact"
        presentationOrder={["iconText", "icon", "collapsed"]}
        collapsedContent="text"
        className="flex-nowrap overflow-hidden"
      />
    </div>
  );
}

export function ChannelChrome({
  title,
  purpose,
  isDm,
  sidebarToggle,
  onBack,
  actions,
  channelId,
  panelSwitcher,
}: {
  title: string;
  purpose?: string | null;
  isDm: boolean;
  sidebarToggle?: ReactNode;
  onBack?: () => void;
  actions: ReactNode;
  channelId?: string;
  panelSwitcher?: ReactNode;
}) {
  const placement = useWindowChromePlacement();

  if (placement === "window") {
    return <WindowChromeActions>{panelSwitcher}{actions}</WindowChromeActions>;
  }

  return (
    <div className="relative z-30 mb-2 flex h-11 shrink-0 items-center gap-3 bg-panel px-4 max-md:gap-1 max-md:px-2">
      {sidebarToggle && <div className="-ml-1 mr-1">{sidebarToggle}</div>}
      {onBack && (
        <UiButton
          variant="plain"
          onClick={onBack}
          title="Back to channels"
          aria-label="Back to channels"
          content="icon"
          controlSize="comfortable"
          className="-ml-1 flex shrink-0 items-center justify-center rounded-sm text-content-primary hover:bg-zinc-800 hover:text-content-strong md:hidden"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        </UiButton>
      )}
      {isDm ? (
        <Mail className="h-4 w-4 shrink-0 text-content-muted max-md:hidden" aria-hidden="true" />
      ) : (
        <Hash className="h-4 w-4 shrink-0 text-content-muted max-md:hidden" aria-hidden="true" />
      )}
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate font-serif text-regular font-bold tracking-tight text-content-strong max-md:pl-1">
          {title}
        </span>
        <span className="hidden items-center gap-1 font-code text-minimal uppercase tracking-overline text-content-muted/75 lg:inline-flex" aria-label="Dispatch channel">
          <span className="select-none text-content-muted/40" aria-hidden="true">·</span>
          DISPATCH
        </span>
      </div>
      {panelSwitcher}
      {purpose && (
        <div className="hidden min-w-0 items-center gap-2 pl-1 md:flex">
          <span className="select-none font-serif text-content-muted/40" aria-hidden="true">—</span>
          <span className="truncate font-reading text-compact italic text-content-muted">{purpose}</span>
        </div>
      )}
      {channelId && <ChannelHeaderSlot channelId={channelId} />}
      <div className="flex-1" />
      {actions}
    </div>
  );
}

import type { ReactNode } from "react";
import { ArrowLeft, Hash, Mail } from "lucide-react";
import { Button as UiButton } from "@/components/ui/button";
import { WindowChromeActions } from "@/features/desktop/WindowChromeActions";
import { useWindowChromePlacement } from "@/features/desktop/WindowChromeContext";
import { ChannelHeaderSlot } from "./extensions/ChannelHeaderSlot";

export function ChannelChrome({
  title,
  purpose,
  isDm,
  sidebarToggle,
  onBack,
  actions,
  channelId,
}: {
  title: string;
  purpose?: string | null;
  isDm: boolean;
  sidebarToggle?: ReactNode;
  onBack?: () => void;
  actions: ReactNode;
  channelId?: string;
}) {
  const placement = useWindowChromePlacement();

  if (placement === "window") {
    return <WindowChromeActions>{actions}</WindowChromeActions>;
  }

  return (
    <div className="relative z-30 mb-2 flex h-11 flex-shrink-0 items-center gap-3 border-b border-zinc-300/40 bg-panel px-4 dark:border-zinc-800/60 max-md:gap-1 max-md:px-2">
      {sidebarToggle && <div className="-ml-1 mr-1">{sidebarToggle}</div>}
      {onBack && (
        <UiButton
          variant="plain"
          onClick={onBack}
          title="Back to channels"
          aria-label="Back to channels"
          content="icon"
          controlSize="comfortable"
          className="-ml-1 flex flex-shrink-0 items-center justify-center rounded-sm text-content-primary hover:bg-zinc-800 hover:text-content-strong md:hidden"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        </UiButton>
      )}
      {isDm ? (
        <Mail className="h-4 w-4 flex-shrink-0 text-content-muted max-md:hidden" aria-hidden="true" />
      ) : (
        <Hash className="h-4 w-4 flex-shrink-0 text-content-muted max-md:hidden" aria-hidden="true" />
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

import type { ReactNode } from "react";
import { ArrowLeft, Hash, MessageSquare } from "lucide-react";
import { Button as UiButton } from "@/components/ui/button";
import { WindowChromeActions } from "@/features/desktop/WindowChromeActions";
import { useWindowChromePlacement } from "@/features/desktop/WindowChromeContext";

export function ChannelChrome({
  title,
  purpose,
  isDm,
  sidebarToggle,
  onBack,
  actions,
}: {
  title: string;
  purpose?: string | null;
  isDm: boolean;
  sidebarToggle?: ReactNode;
  onBack?: () => void;
  actions: ReactNode;
}) {
  const placement = useWindowChromePlacement();

  if (placement === "window") {
    return <WindowChromeActions>{actions}</WindowChromeActions>;
  }

  return (
    <div className="relative z-30 mb-2 flex h-11 flex-shrink-0 items-center gap-3 bg-zinc-950/80 px-4 backdrop-blur-sm max-md:gap-1 max-md:px-2">
      {sidebarToggle && <div className="-ml-1 mr-1">{sidebarToggle}</div>}
      {onBack && (
        <UiButton
          variant="plain"
          onClick={onBack}
          title="Back to channels"
          aria-label="Back to channels"
          content="icon"
          controlSize="comfortable"
          className="-ml-1 flex flex-shrink-0 items-center justify-center rounded-sm text-zinc-100 hover:bg-zinc-800 hover:text-zinc-50 md:hidden"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        </UiButton>
      )}
      {isDm ? (
        <MessageSquare className="h-4 w-4 flex-shrink-0 text-zinc-400 max-md:hidden" aria-hidden="true" />
      ) : (
        <Hash className="h-4 w-4 flex-shrink-0 text-zinc-400 max-md:hidden" aria-hidden="true" />
      )}
      <span className="min-w-0 truncate text-regular font-semibold text-zinc-100 max-md:pl-1">
        {title}
      </span>
      {purpose && (
        <div className="hidden min-w-0 items-center gap-3 pl-1 md:flex">
          <span className="truncate text-compact text-zinc-400">{purpose}</span>
        </div>
      )}
      <div className="flex-1" />
      {actions}
    </div>
  );
}

import type { ReactNode } from "react";
import { Hash, Loader2 } from "lucide-react";

export function ChannelSelectionState({
  pending,
  sidebarToggle,
}: {
  pending: boolean;
  sidebarToggle: ReactNode;
}) {
  if (pending) {
    return (
      <div
        className="flex flex-1 items-center justify-center text-content-muted"
        aria-busy="true"
        aria-label="Loading channels"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="relative flex-1 flex items-center justify-center text-content-muted text-regular flex-col gap-3">
      {sidebarToggle && <div className="absolute top-2.5 left-3">{sidebarToggle}</div>}
      <Hash className="h-5 w-5 text-content-muted" aria-hidden="true" />
      <span>Select a channel to start chatting</span>
    </div>
  );
}

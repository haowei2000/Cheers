import type { ReactNode } from "react";
import { Hash } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { SurfaceSpinner } from "@/components/ui/spinner";

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
        className="flex flex-1 text-content-muted"
        aria-busy="true"
        aria-label="Loading channels"
      >
        <SurfaceSpinner className="flex-1" />
      </div>
    );
  }

  return (
    <div className="relative flex-1">
      {sidebarToggle && <div className="absolute top-2.5 left-3">{sidebarToggle}</div>}
      <EmptyState
        icon={Hash}
        title="Select a channel to start chatting"
        className="h-full px-6 py-0"
      />
    </div>
  );
}

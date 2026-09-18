/** @file Composer banner that identifies the message currently being replied to. */

import { Button as UiButton } from "@/components/ui/button";
import { Reply, X } from "lucide-react";
import type { Message } from "@/types";
import { replyPreviewOf } from "./replyPreview";

/** Show a sanitized reply preview with an action for cancelling reply mode. */
export function ReplyComposerBanner({
  message,
  senderName,
  onCancel,
}: {
  message: Message;
  senderName?: string;
  onCancel: () => void;
}) {
  const preview = replyPreviewOf(message, senderName);
  return (
    <div className="mx-auto w-full max-w-[72rem] px-4 pt-2 max-md:px-3">
      <div
        className="flex items-center gap-3 rounded-sm bg-panel border-l-2 border-l-content-strong/60 px-3 py-2 shadow-2xs"
        role="status"
        aria-label={`Replying to ${preview.sender}`}
      >
        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-sm bg-control text-content-strong">
          <Reply className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-compact font-medium font-utility text-content-strong">
            Replying to {preview.sender}
          </p>
          <p className="truncate font-reading text-compact italic text-content-muted">{preview.excerpt}</p>
        </div>
        <UiButton
          variant="plain"
          type="button"
          onClick={onCancel}
          content="icon"
          controlSize="regular"
          className="flex flex-shrink-0 items-center justify-center rounded-sm text-content-primary transition-colors hover:bg-control hover:text-content-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-content-strong/50"
          aria-label="Cancel reply"
          title="Cancel reply (Esc)"
        >
          <X className="h-4 w-4" />
        </UiButton>
      </div>
    </div>
  );
}

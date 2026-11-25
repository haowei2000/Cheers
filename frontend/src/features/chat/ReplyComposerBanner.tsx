/** @file Composer banner that identifies the message currently being replied to. */

import { ActionButton } from "@/components/ui/action-button";
import { contentIconClasses } from "@/components/ui/content-size";
import { Reply, TextQuote } from "lucide-react";
import type { Message } from "@/types";
import { replyPreviewOf } from "./replyPreview";

/** Show a sanitized reply preview with an action for cancelling reply mode. */
export function ReplyComposerBanner({
  message,
  senderName,
  quote,
  onCancel,
}: {
  message: Message;
  senderName?: string;
  quote?: string;
  onCancel: () => void;
}) {
  const preview = replyPreviewOf(message, senderName);
  const excerpt = quote?.trim();
  const Icon = excerpt ? TextQuote : Reply;
  return (
    <div
      className="flex min-w-0 items-start gap-2 border-b border-content-strong/10 px-3 py-2"
      role="status"
      aria-label={`Replying to ${preview.sender}`}
    >
      <span className="flex h-11 shrink-0 items-center text-content-muted" aria-hidden="true">
        <Icon className={contentIconClasses.regular} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-compact font-medium font-utility text-content-strong">
          Replying to {preview.sender}
        </p>
        {excerpt ? (
          <blockquote
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users need to scroll long excerpts in Safari as well as Chromium.
            tabIndex={0}
            aria-label="Quoted text"
            className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-content-strong/30 pl-2 font-reading text-regular text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-content-strong/50"
          >
            {excerpt}
          </blockquote>
        ) : (
          <p className="truncate font-reading text-compact text-content-muted">{preview.excerpt}</p>
        )}
      </div>
      <ActionButton
        action="cancel"
        context="inlineEdit"
        type="button"
        onClick={onCancel}
        controlSize="comfortable"
        className="flex shrink-0 items-center justify-center rounded-sm text-content-primary transition-colors hover:bg-control hover:text-content-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-content-strong/50"
        accessibleLabel="Cancel reply"
        title="Cancel reply (Esc)"
      />
    </div>
  );
}

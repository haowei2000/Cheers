/** @file Floating inspector for the durable metadata attached to a chat message. */

import { useEffect, useId, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, GripHorizontal, ListTree, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import { IconButton } from "@/components/ui/icon-button";
import { DragHandle } from "@/components/ui/drag-handle";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useWindowDrag } from "@/hooks/useWindowDrag";
import type { Message } from "@/types";
import { BotTracePanel } from "./BotTracePanel";
import { MessageContextChips } from "./context/ContextPickBar";
import type { MessageDetailsMeta } from "./messageDetails";

interface MessageRecordInspectorProps {
  message: Message;
  channelId?: string;
  currentUserId?: string;
  pendingApprovals?: Message[];
  focusRequestId?: string | null;
  meta: MessageDetailsMeta;
  triggerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

/**
 * A message's secondary record: anchored floating window on desktop, bottom sheet on
 * compact screens. Keeping this out of the timeline prevents completed trace
 * history from changing message rhythm while preserving one audited surface.
 */
/** Present message metadata as an accessible dialog and restore focus on close. */
export function MessageRecordInspector({
  message,
  channelId,
  currentUserId,
  pendingApprovals,
  focusRequestId,
  meta,
  triggerRef,
  onClose,
}: MessageRecordInspectorProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const isMobile = useIsMobile();
  const titleId = useId();
  const drag = useWindowDrag(`cheers.message-record.${message.msg_id}`, !isMobile, undefined, {
    anchorRef: triggerRef,
    reanchorOnOpen: true,
    anchorPlacement: "down",
  });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const returnFocusTo = triggerRef.current;
    const focusables = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
    (focusables()[0] ?? panel).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      // The compact sheet is modal. The desktop window is non-modal, so
      // keyboard users may continue into the timeline without closing it.
      if (event.key !== "Tab" || !isMobile) return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener("keydown", onKeyDown);
    return () => {
      panel.removeEventListener("keydown", onKeyDown);
      if (returnFocusTo?.isConnected) returnFocusTo.focus();
    };
  }, [isMobile, triggerRef]);

  const sender = message.sender_name || (message.sender_type === "bot" ? "Bot" : "Member");
  const count = meta.contextCount + meta.traceCount;

  return createPortal(
    // Message records sit above non-modal instrument windows (z 40–43) but below
    // popovers and true dialogs (z 60+ / 100), so a floated panel cannot cover the
    // compact modal sheet and a confirmation opened from the record still wins.
    <div className="fixed inset-0 z-50 pointer-events-none">
      <div
        aria-hidden="true"
        onClick={onClose}
        className="pointer-events-auto absolute inset-0 bg-black/55 md:hidden"
      />
      <aside
        ref={(element) => {
          panelRef.current = element;
          drag.ref(element);
        }}
        role="dialog"
        aria-modal={isMobile}
        aria-labelledby={titleId}
        tabIndex={-1}
        onPointerDownCapture={drag.toFront}
        style={isMobile ? undefined : {
          ...drag.posStyle,
          maxHeight: `min(40rem, calc(100dvh - ${(drag.pos?.y ?? 8) + 8}px))`,
        }}
        className={cn(
          "pointer-events-auto absolute bottom-0 left-0 right-0 max-h-[82dvh] overflow-y-auto overscroll-contain bg-zinc-950 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 outline-none",
          "rounded-t-sm shadow-2xl shadow-black/50",
          "md:bottom-auto md:right-auto md:left-2 md:top-2 md:w-[32rem] md:max-w-[calc(100vw-16px)] md:rounded-sm md:px-6 md:pb-6 md:pt-5",
        )}
      >
        <DragHandle className="mx-auto mb-3 md:hidden" />
        <header {...drag.handleProps} className="flex items-start gap-4 border-b border-zinc-800/80 pb-4">
          <GripHorizontal className="mt-1 hidden h-4 w-4 shrink-0 text-content-muted md:block" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-minimal font-semibold uppercase tracking-overline text-content-muted">
              Message record · {String(count).padStart(2, "0")}
            </p>
            <h2 id={titleId} className="mt-1 text-comfortable font-semibold text-content-primary">
              {sender}
            </h2>
            <p className="mt-1 text-compact tabular-nums text-content-muted">
              {formatTime(message.created_at)} · {message.msg_id.slice(0, 8)}
            </p>
          </div>
          <IconButton
            onClick={onClose}
            label="Close message record"
            title="Close"
            controlSize="compact"
            className="shrink-0 text-content-primary transition-colors hover:text-content-strong"
          >
            <X className="h-4 w-4" />
          </IconButton>
        </header>

        {meta.hasFailure && (
          <div role="alert" className="flex min-h-11 items-center gap-2 border-b border-red-950/80 text-compact text-danger-300">
            <AlertCircle className="h-3.5 w-3.5" />
            One or more agent steps failed.
          </div>
        )}

        <div className="divide-y divide-zinc-800/80">
          {meta.contextCount > 0 && (
            <section className="py-5" aria-labelledby={`${titleId}-references`}>
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h3 id={`${titleId}-references`} className="text-compact font-semibold uppercase tracking-overline text-content-secondary">
                  References
                </h3>
                <span className="text-minimal tabular-nums text-content-muted">{String(meta.contextCount).padStart(2, "0")}</span>
              </div>
              <MessageContextChips bundle={message.context_bundle} className="gap-2" />
            </section>
          )}

          {meta.hasTrace && channelId && (
            <section className="py-5" aria-labelledby={`${titleId}-agent-record`}>
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 id={`${titleId}-agent-record`} className="text-compact font-semibold uppercase tracking-overline text-content-secondary">
                  Agent record
                </h3>
                <span className="inline-flex items-center gap-1 text-minimal tabular-nums text-content-muted">
                  <ListTree className="h-3.5 w-3.5" />
                  {String(meta.traceCount).padStart(2, "0")}
                </span>
              </div>
              <BotTracePanel
                channelId={channelId}
                msgId={message.msg_id}
                liveEvents={message._trace_events}
                pendingApprovals={pendingApprovals}
                currentUserId={currentUserId}
                streaming={Boolean(message._streaming || message.is_partial)}
                focusRequestId={focusRequestId}
                expanded
                showToggle={false}
                view="record"
              />
            </section>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

import { useEffect, useId, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, ListTree, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import { IconButton } from "@/components/ui/icon-button";
import { useIsMobile } from "@/hooks/useIsMobile";
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
 * A message's secondary record: docked inspector on desktop, bottom sheet on
 * compact screens. Keeping this out of the timeline prevents completed trace
 * history from changing message rhythm while preserving one audited surface.
 */
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
  const panelRef = useRef<HTMLElement>(null);
  const isMobile = useIsMobile();
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
    (focusables()[0] ?? panel).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      // The compact sheet is modal. The desktop inspector is a docked lane, so
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
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
    };
  }, [isMobile, triggerRef]);

  const sender = message.sender_name || (message.sender_type === "bot" ? "Bot" : "Member");
  const count = meta.contextCount + meta.traceCount;

  return createPortal(
    <div className="fixed inset-0 z-[100] pointer-events-none">
      <div
        aria-hidden="true"
        onClick={onClose}
        className="pointer-events-auto absolute inset-0 bg-black/55 md:hidden"
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal={isMobile}
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "pointer-events-auto absolute bottom-0 left-0 right-0 max-h-[82dvh] overflow-y-auto overscroll-contain bg-zinc-950 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 outline-none",
          "rounded-t-xl shadow-2xl shadow-black/50",
          "md:bottom-0 md:left-auto md:top-0 md:w-[23rem] md:max-h-none md:rounded-none md:border-l md:border-zinc-800/80 md:px-6 md:pb-6 md:pt-5",
        )}
      >
        <div className="mx-auto mb-3 h-1 w-8 rounded-full bg-zinc-700 md:hidden" aria-hidden />
        <header className="flex items-start gap-4 border-b border-zinc-800/80 pb-4">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
              Message record · {String(count).padStart(2, "0")}
            </p>
            <h2 id={titleId} className="mt-1 text-base font-semibold text-zinc-100">
              {sender}
            </h2>
            <p className="mt-0.5 text-[11px] tabular-nums text-zinc-500">
              {formatTime(message.created_at)} · {message.msg_id.slice(0, 8)}
            </p>
          </div>
          <IconButton
            onClick={onClose}
            label="Close message record"
            title="Close"
            controlSize="compact"
            className="flex h-11 w-11 shrink-0 items-center justify-center text-zinc-500 transition-colors hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/70 md:h-8 md:w-8"
          >
            <X className="h-4 w-4" />
          </IconButton>
        </header>

        {meta.hasFailure && (
          <div role="alert" className="flex min-h-11 items-center gap-2 border-b border-red-950/80 text-xs text-red-300">
            <AlertCircle className="h-3.5 w-3.5" />
            One or more agent steps failed.
          </div>
        )}

        <div className="divide-y divide-zinc-800/80">
          {meta.contextCount > 0 && (
            <section className="py-5" aria-labelledby={`${titleId}-references`}>
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h3 id={`${titleId}-references`} className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-300">
                  References
                </h3>
                <span className="text-[10px] tabular-nums text-zinc-500">{String(meta.contextCount).padStart(2, "0")}</span>
              </div>
              <MessageContextChips bundle={message.context_bundle} className="gap-2" />
            </section>
          )}

          {meta.hasTrace && channelId && (
            <section className="py-5" aria-labelledby={`${titleId}-agent-record`}>
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 id={`${titleId}-agent-record`} className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-300">
                  Agent record
                </h3>
                <span className="inline-flex items-center gap-1 text-[10px] tabular-nums text-zinc-500">
                  <ListTree className="h-3 w-3" />
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
              />
            </section>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

import type { BotTraceEvent, MemoryLoadDetail, Message } from "../../types";
import { streamTraceLabel, traceTimeLabel } from "../../lib/bot-trace";
import { Modal } from "../Modal";

interface MessageDetailModalProps {
  botTraceEvents: BotTraceEvent[];
  memoryLoadDetail: MemoryLoadDetail | null;
  message: Message | null;
  onClose: () => void;
}

export function MessageDetailModal({
  botTraceEvents,
  memoryLoadDetail,
  message,
  onClose,
}: MessageDetailModalProps) {
  return (
    <Modal
      open={!!message}
      onClose={onClose}
      title="AI reply details"
      description={
        memoryLoadDetail
          ? `Trigger message ${memoryLoadDetail.trigger_msg_id || "-"} · ${memoryLoadDetail.trigger_msg_type || "normal"}`
          : message
            ? `Messages ${message.msg_id}`
            : undefined
      }
      maxWidth="max-w-4xl"
    >
      <div className="max-h-[72vh] space-y-5 overflow-y-auto pr-1">
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold" style={{ color: "var(--fg-1)" }}>
              Memory calls
            </h3>
            {memoryLoadDetail && (
              <span className="text-[11px]" style={{ color: "var(--fg-3)" }}>
                {memoryLoadDetail.total_chars ?? 0} chars
              </span>
            )}
          </div>
          {memoryLoadDetail ? (
            <>
              <div
                className="grid gap-2 rounded-lg border p-3 text-xs sm:grid-cols-3"
                style={{ borderColor: "var(--border)" }}
              >
                <div>
                  <div style={{ color: "var(--fg-3)" }}>Load strategy</div>
                  <div className="mt-0.5 font-mono break-all">
                    {memoryLoadDetail.strategy || "-"}
                  </div>
                </div>
                <div>
                  <div style={{ color: "var(--fg-3)" }}>Requested layers</div>
                  <div className="mt-0.5">
                    {(memoryLoadDetail.requested_layers || []).join(", ") || "-"}
                  </div>
                </div>
                <div>
                  <div style={{ color: "var(--fg-3)" }}>Trigger type</div>
                  <div className="mt-0.5">
                    {memoryLoadDetail.trigger_msg_type || "normal"}
                  </div>
                </div>
              </div>
              <div className="space-y-3">
                {(memoryLoadDetail.layers || []).map((layer) => (
                  <div
                    key={layer.source}
                    className="rounded-lg border p-3"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">
                        {layer.label || layer.source}
                      </span>
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px]"
                        style={{
                          background: layer.requested
                            ? "var(--accent-muted)"
                            : "var(--surface-soft)",
                          color: layer.requested ? "var(--accent)" : "var(--fg-3)",
                        }}
                      >
                        {layer.requested ? "Requested" : "Not requested"}
                      </span>
                      <span className="text-[11px]" style={{ color: "var(--fg-3)" }}>
                        {layer.chars || 0} chars
                      </span>
                      <span className="text-[11px] font-mono" style={{ color: "var(--fg-3)" }}>
                        {layer.loader || layer.source}
                      </span>
                    </div>
                    {layer.preview ? (
                      <pre
                        className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md p-2 text-[11px] leading-relaxed"
                        style={{
                          background: "var(--surface-soft)",
                          color: "var(--fg-2)",
                        }}
                      >
                        {layer.preview}
                      </pre>
                    ) : (
                      <div className="mt-2 text-xs" style={{ color: "var(--fg-3)" }}>
                        {layer.requested ? "No content is available for this layer." : "This layer was not requested for this load."}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: "var(--border)", color: "var(--fg-3)" }}>
              This message has no displayable memory load information.
            </div>
          )}
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold" style={{ color: "var(--fg-1)" }}>
              Streaming event trace
            </h3>
            <span className="text-[11px]" style={{ color: "var(--fg-3)" }}>
              {botTraceEvents.length} events
            </span>
          </div>
          {botTraceEvents.length ? (
            <div className="space-y-2">
              {botTraceEvents.map((event, index) => {
                const eventData = event.data || {};
                return (
                  <div
                    key={`${event.stream || "trace"}-${event.phase || "event"}-${event.seq ?? index}-${event.ts ?? index}`}
                    className="rounded-lg border p-3"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px] font-mono"
                        style={{
                          background: "var(--surface-soft)",
                          color: "var(--fg-3)",
                        }}
                      >
                        #{index + 1}
                      </span>
                      {event.ts && (
                        <span className="text-[11px] font-mono" style={{ color: "var(--fg-3)" }}>
                          {traceTimeLabel(event.ts)}
                        </span>
                      )}
                      <span className="text-xs font-semibold" style={{ color: "var(--fg-1)" }}>
                        {streamTraceLabel(event)}
                      </span>
                      <span className="text-[11px] font-mono" style={{ color: "var(--fg-3)" }}>
                        {event.stream || "trace"}
                        {event.phase ? `/${event.phase}` : ""}
                      </span>
                    </div>
                    {Object.keys(eventData).length > 0 && (
                      <pre
                        className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md p-2 text-[11px] leading-relaxed"
                        style={{
                          background: "var(--surface-soft)",
                          color: "var(--fg-2)",
                        }}
                      >
                        {JSON.stringify(eventData, null, 2)}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: "var(--border)", color: "var(--fg-3)" }}>
              This page session has not captured streaming events for this reply yet.
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}

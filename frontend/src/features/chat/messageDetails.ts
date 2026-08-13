/** @file Derive the summary state used by the message-details disclosure UI. */

import type { Message } from "@/types";

export interface MessageDetailsMeta {
  contextCount: number;
  traceCount: number;
  hasTrace: boolean;
  hasFailure: boolean;
  hasDetails: boolean;
}

/** Derive disclosure visibility from durable summary fields plus live events.
 *  `Math.max` avoids double-counting live rows already present in persistence. */
export function messageDetailsMeta(
  message: Message,
  actionableApprovalCount = 0,
): MessageDetailsMeta {
  const contextCount = message.context_bundle?.items?.length ?? 0;
  const liveEvents = message._trace_events ?? [];
  const traceCount = Math.max(
    message.trace_count ?? 0,
    liveEvents.length,
    actionableApprovalCount,
  );
  const hasFailure = Boolean(
    message.trace_has_failure ||
      liveEvents.some(
        (event) =>
          event.phase === "prompt_failed" ||
          event.phase === "terminal_ack_failed" ||
          event.status === "failed" ||
          event.status === "error",
      ),
  );
  const hasTrace = traceCount > 0 || actionableApprovalCount > 0;
  return {
    contextCount,
    traceCount,
    hasTrace,
    hasFailure,
    hasDetails: contextCount > 0 || hasTrace,
  };
}

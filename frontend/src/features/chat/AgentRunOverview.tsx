import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, CircleHelp, Clock, ListTree, ShieldCheck, Square } from "lucide-react";
import type { Message, TraceEvent } from "@/types";
import { fetchMessageTrace } from "@/api/approval";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { controlIconClasses } from "@/components/ui/control-size";
import { cn } from "@/lib/cn";
import { agentRunSummary } from "./agentRunSummary";

/** A compact message-record disclosure. Durable traces restore the same outcome after reload. */
export function AgentRunOverview({ message, channelId, approvalCount = 0, expanded, onOpen }: {
  message: Message;
  channelId?: string;
  approvalCount?: number;
  expanded: boolean;
  onOpen: (trigger: HTMLElement) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [record, setRecord] = useState<{ msgId: string; traceCount?: number; events: TraceEvent[] } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const summary = agentRunSummary(message, record?.msgId === message.msg_id ? record.events : [], approvalCount);
  const active = Boolean(message._streaming || message.is_partial);
  const needsRecord = !active && Boolean(channelId) &&
    (record?.msgId !== message.msg_id || record.traceCount !== message.trace_count);

  useEffect(() => {
    if (!needsRecord || !channelId) return;
    let cancelled = false;
    let started = false;
    const load = () => {
      if (started) return;
      started = true;
      setLoadFailed(false);
      void fetchMessageTrace(channelId, message.msg_id).then(
        result => { if (!cancelled) setRecord({ msgId: message.msg_id, traceCount: message.trace_count, events: result.events }); },
        () => { if (!cancelled) setLoadFailed(true); },
      );
    };
    // A channel can contain many completed turns; read only visible overviews.
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) load();
    });
    if (triggerRef.current) observer.observe(triggerRef.current);
    return () => { cancelled = true; observer.disconnect(); };
  }, [needsRecord, channelId, message.msg_id, message.trace_count]);

  const Icon = summary.status === "completed" ? Check
    : summary.status === "failed" ? AlertCircle
    : summary.status === "cancelled" ? Square
    : summary.status === "approval" ? ShieldCheck
    : summary.status === "unknown" ? CircleHelp : Clock;
  const label = loadFailed && summary.status === "unknown" ? "Run summary unavailable" : summary.label;
  const text = [label, summary.detail].filter(Boolean).join(" · ");
  return (
    <ControlTrigger
      ref={triggerRef}
      controlSize="regular"
      controlWidth="content"
      aria-label={`Open message record: ${text}`}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      title={text}
      onClick={event => onOpen(event.currentTarget)}
      className={cn("max-w-full justify-start text-left", summary.tone === "danger" ? "text-danger-400" : "text-content-primary")}
    >
      <Icon className={cn(controlIconClasses.regular, "shrink-0")} aria-hidden="true" />
      <span className="min-w-0 truncate" aria-live="polite">{text}</span>
      <ListTree className={cn(controlIconClasses.regular, "shrink-0")} aria-hidden="true" />
    </ControlTrigger>
  );
}

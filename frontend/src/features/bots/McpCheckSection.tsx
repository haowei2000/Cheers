import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  MinusCircle,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import {
  checkHostMcp,
  type McpCheckReport,
  type McpCheckStatus,
} from "@/api/bots";
import { ActionButton } from "@/components/ui/action-button";
import { ButtonGroup } from "@/components/ui/button-group";
import { MetaRow, SectionHead } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { messageOf } from "@/lib/notify";

const statusPresentation: Record<
  McpCheckStatus,
  { label: string; Icon: LucideIcon; tone: string }
> = {
  pass: { label: "Passed", Icon: CheckCircle2, tone: "text-success-400" },
  warn: { label: "Needs attention", Icon: AlertTriangle, tone: "text-warning-400" },
  fail: { label: "Failed", Icon: XCircle, tone: "text-danger-400" },
  skip: { label: "Not applicable", Icon: MinusCircle, tone: "text-content-muted" },
};

const overallSummary: Record<McpCheckStatus, string> = {
  pass: "Cheers MCP is working",
  warn: "Cheers MCP works, with warnings",
  fail: "Cheers MCP is not working",
  skip: "Nothing to check for this host",
};

/** Runs the Cheers MCP check for one host on request. The check is read-only, so
 *  the same control doubles as Retry after a failed read. */
export function McpCheckSection({
  botId,
  hostId,
  deviceName,
}: {
  botId: string;
  hostId: string;
  deviceName: string;
}) {
  const [report, setReport] = useState<McpCheckReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const run = async () => {
    setChecking(true);
    setError(null);
    try {
      setReport(await checkHostMcp(botId, hostId));
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setChecking(false);
    }
  };
  return (
    <section className="space-y-3" aria-busy={checking}>
      <div className="flex items-center justify-between gap-3">
        <SectionHead>Cheers MCP</SectionHead>
        <ButtonGroup label="Cheers MCP check controls">
          <ActionButton
            action="check"
            context="settings"
            accessibleLabel={`Check Cheers MCP for ${deviceName}`}
            loading={checking}
            disabled={checking}
            onClick={() => void run()}
          />
        </ButtonGroup>
      </div>
      {error && (
        <p role="alert" className="text-compact text-danger-400">
          {error}
        </p>
      )}
      {report && <McpCheckResults report={report} />}
    </section>
  );
}

/** One row per check, grouped by layer: status glyph, what was found, and what to do. */
export function McpCheckResults({ report }: { report: McpCheckReport }) {
  const overall = statusPresentation[report.status];
  return (
    <div className="space-y-4">
      <p
        role="status"
        className={cn("flex items-center gap-2 text-compact", overall.tone)}
      >
        <overall.Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          {overallSummary[report.status]} · Checked{" "}
          {new Date(report.checked_at).toLocaleTimeString()}
        </span>
      </p>
      {/* design-system-exempt: item-section — check verdicts grouped by layer. */}
      {report.layers.map((layer) => (
        <div key={layer.id} className="space-y-2">
          <p className="text-minimal uppercase tracking-label text-content-muted">
            {layer.title}
          </p>
          <ul className="space-y-2">
            {layer.checks.map((check) => {
              const status = statusPresentation[check.status];
              return (
                <li key={check.id}>
                  <MetaRow label={check.label} className="items-start">
                    {/* Own flex line so the glyph aligns with the summary, not the block's middle. */}
                    <span className="flex min-w-0 flex-1 items-start gap-2">
                      <span
                        role="img"
                        aria-label={status.label}
                        className={cn("inline-flex shrink-0", status.tone)}
                      >
                        <status.Icon className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1 space-y-1">
                        <span className="block break-words text-content-secondary">
                          {check.summary}
                          {check.observed_at && (
                            <span className="text-content-muted">
                              {" "}
                              · {new Date(check.observed_at).toLocaleString()}
                            </span>
                          )}
                        </span>
                        {check.detail && (
                          <span className="block break-words text-compact text-content-muted">
                            {check.detail}
                          </span>
                        )}
                        {check.hint && (
                          <span className="block break-words text-compact text-content-muted">
                            {check.hint}
                          </span>
                        )}
                      </span>
                    </span>
                  </MetaRow>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

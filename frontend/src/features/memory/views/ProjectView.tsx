import { MessageMarkdown } from "../../../MessageMarkdown";
import type { MemoryEntryItem } from "../../../types";

// ═════════════════════════════════════════════════════════════════════════════
// Project view — design's PROJECT tab rendered as a journey diagram.
// Anchor node with progress ring, legend, a vertical river of decision /
// progress nodes (chronological), and a dashed end-node with the goal state.
// ═════════════════════════════════════════════════════════════════════════════

export function ProjectView({
  anchors,
  progress,
  decisions,
  loading,
}: {
  anchors: MemoryEntryItem[];
  progress: MemoryEntryItem[];
  decisions: MemoryEntryItem[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div
        className="flex items-center justify-center h-20 text-xs"
        style={{ color: "var(--fg-3)" }}
      >
        Loading...
      </div>
    );
  }

  const doneRe = /done|Done|\u5df2\u505a|shipped|merged|resolved|\u6279\u51c6|approved/i;
  const isDone = (e: MemoryEntryItem) =>
    doneRe.test(e.content + " " + (e.title || ""));
  const progressDone = progress.filter(isDone).length;
  const progressPending = progress.length - progressDone;
  const totalSteps = progress.length + decisions.length;
  const completed = progressDone + decisions.length;
  const pct = totalSteps === 0 ? 0 : Math.round((completed / totalSteps) * 100);

  // Chronological river combining progress + decisions (oldest first).
  const tsOf = (e: MemoryEntryItem) => e.updated_at || e.created_at || "";
  const river = [
    ...progress.map((e) => ({
      item: e,
      kind: isDone(e) ? "progress" : "progress-pending",
      ts: tsOf(e),
    })),
    ...decisions.map((e) => ({
      item: e,
      kind: "decision",
      ts: tsOf(e),
    })),
  ].sort((a, b) => (a.ts < b.ts ? -1 : 1));

  const [primaryAnchor, ...restAnchors] = anchors;
  const empty =
    anchors.length === 0 && progress.length === 0 && decisions.length === 0;

  // Progress ring geometry
  const R = 22;
  const C = 2 * Math.PI * R;
  const off = C * (1 - pct / 100);

  if (empty) {
    return (
      <div className="px-3 py-3">
        <div
          className="text-center py-10 text-xs"
          style={{ color: "var(--fg-3)" }}
        >
          No project anchor or progress yet.
          <br />
          Click Edit in the top-right to add anchors or progress. They will appear here.
        </div>
      </div>
    );
  }

  return (
    <div className="px-3 py-3">
      <div className="an-journey">
        {primaryAnchor && (
          <div className="an-anchor-node">
            <div className="an-ring">
              <svg viewBox="0 0 52 52">
                <circle className="an-ring-track" cx="26" cy="26" r={R} />
                <circle
                  className="an-ring-fill"
                  cx="26"
                  cy="26"
                  r={R}
                  strokeDasharray={C}
                  strokeDashoffset={off}
                />
              </svg>
              <div className="an-ring-pct">{pct}%</div>
            </div>
            <div className="an-info">
              <div className="an-tg">Anchor</div>
              {primaryAnchor.title && (
                <div
                  className="an-tx"
                  style={{ fontWeight: 600, marginBottom: 2 }}
                >
                  {primaryAnchor.title}
                </div>
              )}
              <div className="an-tx">
                <MessageMarkdown text={primaryAnchor.content} />
              </div>
              <div className="an-mt">
                {completed} / {totalSteps} steps
                {primaryAnchor.updated_at && (
                  <> · {new Date(primaryAnchor.updated_at).toLocaleString()}</>
                )}
              </div>
            </div>
          </div>
        )}

        {restAnchors.length > 0 && (
          <div style={{ marginTop: 8, paddingLeft: 2 }}>
            {restAnchors.map((a) => (
              <div
                key={a.entry_id}
                style={{
                  fontSize: 11.5,
                  color: "var(--fg-2)",
                  padding: "4px 0",
                  display: "flex",
                  gap: 6,
                  alignItems: "baseline",
                }}
              >
                <span
                  style={{
                    width: 4,
                    height: 4,
                    borderRadius: "50%",
                    background: "var(--accent)",
                    display: "inline-block",
                    marginRight: 4,
                    flexShrink: 0,
                  }}
                />
                <span style={{ flex: 1 }}>{a.title || a.content}</span>
                {a.updated_at && (
                  <span style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                    {new Date(a.updated_at).toLocaleDateString()}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="an-legend">
          <span className="an-lg decision">
            <span className="an-sq" />
            Decision
          </span>
          <span className="an-lg progress">
            <span className="an-sq" />
            Progress
          </span>
          <span className="an-lg todo">
            <span className="an-sq" />
            Pending
          </span>
        </div>

        {river.length > 0 && (
          <>
            <div className="an-sh first">Path so far</div>
            <div className="an-river">
              {river.map(({ item, kind }) => {
                const isPending = kind === "progress-pending";
                const rowCls = isPending
                  ? "an-riv todo"
                  : kind === "decision"
                    ? "an-riv decision"
                    : "an-riv progress";
                const kindLabel =
                  kind === "decision"
                    ? "Decision"
                    : isPending
                      ? "In progress"
                      : "Progress";
                return (
                  <div key={item.entry_id} className={rowCls}>
                    <span className="an-marker" />
                    <div className="an-card">
                      <div className="an-kind">{kindLabel}</div>
                      {item.title && (
                        <div
                          className="an-tx"
                          style={{ fontWeight: 600, marginBottom: 2 }}
                        >
                          {item.title}
                        </div>
                      )}
                      <div className="an-tx">
                        <MessageMarkdown text={item.content} />
                      </div>
                      {item.updated_at && (
                        <div className="an-mt">
                          {new Date(item.updated_at).toLocaleString()}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="an-end-node">
          <div className="an-cir" />
          <div className="an-tx">
            <b>Goal state.</b>{" "}
            {progressPending === 0 && totalSteps > 0
              ? "All known steps complete."
              : progressPending > 0
                ? `${progressPending} step${progressPending === 1 ? "" : "s"} in progress toward anchor.`
                : "Waiting on first progress entry."}
          </div>
        </div>
      </div>
    </div>
  );
}

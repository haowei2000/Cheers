/**
 * Helpers for rendering ACP `file_edit` content blocks
 * (`{ type: "diff", path, oldText, newText }`) in the trace inspector.
 *
 * Mirrors the connector's approval-diff approach: emit a bounded unified diff
 * with context around changes, not a full-file LCS dump of every unchanged line.
 */

export interface FileDiff {
  path: string;
  oldText: string;
  newText: string;
}

export interface DiffStats {
  additions: number;
  deletions: number;
}

const DIFF_SOURCE_LIMIT = 8_000;
const DIFF_LINE_LIMIT = 2_000;
/** Context lines kept on each side of a change hunk (matches connector radius). */
const CONTEXT_RADIUS = 3;

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function stringField(record: JsonRecord | null, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/** Basename for compact row labels; full path stays in `title` tooltips. */
export function pathBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function fileDiffsFromData(data: JsonRecord | null): FileDiff[] {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks.flatMap((block, index) => {
    const diff = asRecord(block);
    if (diff?.type !== "diff") return [];
    const oldText = typeof diff.oldText === "string"
      ? diff.oldText
      : typeof diff.old_text === "string"
        ? diff.old_text
        : "";
    const newText = typeof diff.newText === "string"
      ? diff.newText
      : typeof diff.new_text === "string"
        ? diff.new_text
        : "";
    // Identical sides are not edits — skip so empty state can surface cleanly.
    if (oldText === newText) return [];
    return [{
      path: stringField(diff, "path") ?? `File ${index + 1}`,
      oldText,
      newText,
    }];
  });
}

type Op =
  | { kind: "eq"; line: string }
  | { kind: "del"; line: string }
  | { kind: "add"; line: string };

/** Line-level Myers/LCS ops — same algorithm the inspector used before, reused for hunking. */
function lineOps(oldText: string, newText: string): Op[] {
  const oldLines = oldText ? oldText.split("\n") : [];
  const newLines = newText ? newText.split("\n") : [];
  const width = newLines.length + 1;
  const lcs = new Uint16Array((oldLines.length + 1) * width);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
      const offset = oldIndex * width + newIndex;
      lcs[offset] = oldLines[oldIndex] === newLines[newIndex]
        ? lcs[(oldIndex + 1) * width + newIndex + 1] + 1
        : Math.max(
          lcs[(oldIndex + 1) * width + newIndex],
          lcs[oldIndex * width + newIndex + 1],
        );
    }
  }

  const ops: Op[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (
      oldIndex < oldLines.length
      && newIndex < newLines.length
      && oldLines[oldIndex] === newLines[newIndex]
    ) {
      ops.push({ kind: "eq", line: oldLines[oldIndex++] });
      newIndex++;
    } else if (
      newIndex < newLines.length
      && (
        oldIndex === oldLines.length
        || lcs[oldIndex * width + newIndex + 1] >= lcs[(oldIndex + 1) * width + newIndex]
      )
    ) {
      ops.push({ kind: "add", line: newLines[newIndex++] });
    } else {
      ops.push({ kind: "del", line: oldLines[oldIndex++] });
    }
  }
  return ops;
}

export function diffStats(diff: FileDiff): DiffStats {
  let additions = 0;
  let deletions = 0;
  for (const op of lineOps(diff.oldText, diff.newText)) {
    if (op.kind === "add") additions++;
    else if (op.kind === "del") deletions++;
  }
  return { additions, deletions };
}

export function aggregateDiffStats(diffs: FileDiff[]): DiffStats {
  return diffs.reduce(
    (acc, diff) => {
      const stats = diffStats(diff);
      return {
        additions: acc.additions + stats.additions,
        deletions: acc.deletions + stats.deletions,
      };
    },
    { additions: 0, deletions: 0 },
  );
}

function unifiedDiff(path: string, body: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...body,
  ].join("\n");
}

/**
 * Bounded unified diff with CONTEXT_RADIUS around changes.
 * Oversized sources decline rather than misrepresent every line as a rewrite.
 */
export function fileDiffPreview({ path, oldText, newText }: FileDiff): string {
  const oldLines = oldText ? oldText.split("\n") : [];
  const newLines = newText ? newText.split("\n") : [];
  if (
    oldText.length + newText.length > DIFF_SOURCE_LIMIT
    || oldLines.length + newLines.length > DIFF_LINE_LIMIT
  ) {
    return unifiedDiff(path, [
      "@@ diff omitted @@",
      " Diff is too large to render safely in the inspector.",
    ]);
  }

  const ops = lineOps(oldText, newText);
  if (ops.length === 0 || ops.every((op) => op.kind === "eq")) {
    return unifiedDiff(path, ["@@ no changes @@"]);
  }

  // Mark ops that sit within CONTEXT_RADIUS of a change.
  const keep = new Uint8Array(ops.length);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].kind === "eq") continue;
    const from = Math.max(0, i - CONTEXT_RADIUS);
    const to = Math.min(ops.length - 1, i + CONTEXT_RADIUS);
    for (let j = from; j <= to; j++) keep[j] = 1;
  }

  const hunks: string[] = [];
  let i = 0;
  while (i < ops.length) {
    if (!keep[i]) {
      i++;
      continue;
    }

    const start = i;
    let end = i;
    while (end + 1 < ops.length && keep[end + 1]) end++;

    // Hunk header line numbers come from ops before `start`.
    let oldStart = 1;
    let newStart = 1;
    for (let j = 0; j < start; j++) {
      if (ops[j].kind === "eq") {
        oldStart++;
        newStart++;
      } else if (ops[j].kind === "del") {
        oldStart++;
      } else {
        newStart++;
      }
    }

    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let j = start; j <= end; j++) {
      const op = ops[j];
      if (op.kind === "eq") {
        body.push(` ${op.line}`);
        oldCount++;
        newCount++;
      } else if (op.kind === "del") {
        body.push(`-${op.line}`);
        oldCount++;
      } else {
        body.push(`+${op.line}`);
        newCount++;
      }
    }
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body);
    i = end + 1;
  }

  return unifiedDiff(path, hunks);
}

export function formatDiffDelta(stats: DiffStats): string {
  return `+${stats.additions} −${stats.deletions}`;
}

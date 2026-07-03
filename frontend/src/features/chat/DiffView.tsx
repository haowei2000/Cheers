/**
 * Self-contained unified-diff renderer (no external highlighter).
 *
 * Takes raw `git diff --no-color` text and colors it line-by-line: additions
 * green, deletions red, hunk headers accented, file/metadata lines dimmed. Used
 * by the remote-workspace Changes tab and by the approval card's "view staged
 * diff" action — keep it dependency-free so both can share it.
 */

type DiffKind = "add" | "del" | "hunk" | "meta" | "ctx";

interface DiffLine {
  kind: DiffKind;
  text: string;
}

// Guard against pathological DOM size; the API already caps bytes at 10MB, but a
// minified/generated file can still be tens of thousands of lines.
const MAX_LINES = 2000;

function classify(line: string): DiffKind {
  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("similarity ") ||
    line.startsWith("rename ") ||
    line.startsWith("copy ") ||
    line.startsWith("Binary files")
  ) {
    return "meta";
  }
  if (line.startsWith("@@")) return "hunk";
  // `+`/`-` but not the `+++`/`---` file headers (handled by meta above).
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

const LINE_CLASS: Record<DiffKind, string> = {
  add: "text-emerald-300 bg-emerald-500/10",
  del: "text-rose-300 bg-rose-500/10",
  hunk: "text-cyan-300/90 bg-cyan-500/5",
  meta: "text-zinc-500",
  ctx: "text-zinc-300/80",
};

export function DiffView({
  diff,
  className,
}: {
  diff: string;
  className?: string;
}) {
  if (!diff.trim()) {
    return (
      <div className="px-3 py-4 text-[11px] text-zinc-600">No changes.</div>
    );
  }

  const raw = diff.replace(/\n$/, "").split("\n");
  const truncated = raw.length > MAX_LINES;
  const shown = truncated ? raw.slice(0, MAX_LINES) : raw;
  const lines: DiffLine[] = shown.map((text) => ({ kind: classify(text), text }));

  return (
    <div className={`overflow-auto ${className ?? ""}`}>
      <div className="w-max min-w-full font-mono text-[11px] leading-[1.55]">
        {lines.map((l, i) => (
          <div key={i} className={`whitespace-pre px-2 ${LINE_CLASS[l.kind]}`}>
            {l.text || " "}
          </div>
        ))}
        {truncated && (
          <div className="whitespace-pre px-2 py-1 text-zinc-500 italic">
            … diff truncated ({raw.length - MAX_LINES} more lines)
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Self-contained unified-diff renderer (no external highlighter).
 *
 * Takes raw `git diff --no-color` text and renders it as per-file sections:
 * a sticky diffstat summary, collapsible file headers with +/− counts, and a
 * line-number gutter derived from the hunk headers. Additions green, deletions
 * red, hunk headers accented. Used by the remote-workspace Changes/History tabs
 * and by the approval card's "view staged diff" action — keep it dependency-free
 * so both can share it.
 *
 * DOM safety: instead of one global truncation, each file section renders at
 * most `PAGE_LINES` rows and extends on demand ("show more"); sections larger
 * than `AUTO_COLLAPSE_LINES` start collapsed. A pathological diff therefore
 * costs clicks, never a frozen tab.
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

type DiffKind = "add" | "del" | "hunk" | "meta" | "ctx";

interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line number in the old / new file (undefined for meta/hunk rows). */
  oldNo?: number;
  newNo?: number;
}

interface FileSection {
  /** Display path (new path; `old → new` for renames). */
  title: string;
  lines: DiffLine[];
  adds: number;
  dels: number;
  binary: boolean;
}

/** Per-section rows rendered before "show more" is needed. */
const PAGE_LINES = 1500;
/** Sections longer than this start collapsed (multi-file diffs stay skimmable). */
const AUTO_COLLAPSE_LINES = 400;

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
  meta: "text-zinc-400",
  ctx: "text-zinc-300/80",
};

/** `a/src/x.ts` → `src/x.ts` (also tolerates plain paths and `/dev/null`). */
function stripPrefix(p: string): string {
  if (p === "/dev/null") return p;
  return p.replace(/^[ab]\//, "");
}

/** Display title for a section from its `diff --git` / `---` / `+++` headers. */
function sectionTitle(headerLines: string[]): string {
  let oldPath = "";
  let newPath = "";
  for (const l of headerLines) {
    if (l.startsWith("--- ")) oldPath = stripPrefix(l.slice(4).trim());
    else if (l.startsWith("+++ ")) newPath = stripPrefix(l.slice(4).trim());
  }
  if (!oldPath && !newPath) {
    // Fall back to the `diff --git a/x b/y` line (e.g. binary files: no ---/+++).
    const dg = headerLines.find((l) => l.startsWith("diff --git "));
    if (dg) {
      const m = dg.match(/^diff --git a\/(.*) b\/(.*)$/);
      if (m) {
        oldPath = m[1];
        newPath = m[2];
      }
    }
  }
  if (newPath === "/dev/null") return `${oldPath} (deleted)`;
  if (oldPath === "/dev/null") return `${newPath} (new)`;
  if (oldPath && newPath && oldPath !== newPath) return `${oldPath} → ${newPath}`;
  return newPath || oldPath || "(diff)";
}

/**
 * Parse the raw diff into file sections, numbering lines from the `@@ -a,b +c,d`
 * hunk headers as we go. Text before the first `diff --git` (a bare hunk diff,
 * e.g. `git diff` inside one file) becomes a single untitled section.
 */
export function parseSections(diff: string): FileSection[] {
  const raw = diff.replace(/\n$/, "").split("\n");
  const sections: FileSection[] = [];
  let cur: FileSection | null = null;
  let curHeader: string[] = [];
  let oldNo = 0;
  let newNo = 0;

  const push = () => {
    if (cur) {
      cur.title = cur.title || sectionTitle(curHeader);
      sections.push(cur);
    }
  };

  for (const text of raw) {
    const kind = classify(text);
    if (text.startsWith("diff --git ")) {
      push();
      cur = { title: "", lines: [], adds: 0, dels: 0, binary: false };
      curHeader = [text];
      cur.lines.push({ kind: "meta", text });
      continue;
    }
    if (!cur) {
      cur = { title: "", lines: [], adds: 0, dels: 0, binary: false };
      curHeader = [];
    }
    if (kind === "meta") {
      curHeader.push(text);
      if (text.startsWith("Binary files")) cur.binary = true;
      cur.lines.push({ kind, text });
      continue;
    }
    if (kind === "hunk") {
      const m = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNo = m ? parseInt(m[1], 10) : 0;
      newNo = m ? parseInt(m[2], 10) : 0;
      cur.lines.push({ kind, text });
      continue;
    }
    if (kind === "add") {
      cur.adds += 1;
      cur.lines.push({ kind, text, newNo: newNo || undefined });
      newNo += 1;
    } else if (kind === "del") {
      cur.dels += 1;
      cur.lines.push({ kind, text, oldNo: oldNo || undefined });
      oldNo += 1;
    } else {
      cur.lines.push({
        kind,
        text,
        oldNo: oldNo || undefined,
        newNo: newNo || undefined,
      });
      oldNo += 1;
      newNo += 1;
    }
  }
  push();
  return sections;
}

function Gutter({ line }: { line: DiffLine }) {
  const num = (n?: number) => (n == null ? "" : String(n));
  return (
    <span className="sticky left-0 shrink-0 select-none bg-zinc-950/95 pr-1.5 text-right text-zinc-400">
      <span className="inline-block w-10">{num(line.oldNo)}</span>
      <span className="inline-block w-10">{num(line.newNo)}</span>
    </span>
  );
}

function FileSectionView({ section }: { section: FileSection }) {
  const [open, setOpen] = useState(section.lines.length <= AUTO_COLLAPSE_LINES);
  const [shown, setShown] = useState(PAGE_LINES);
  const lines = open ? section.lines.slice(0, shown) : [];
  const hidden = section.lines.length - lines.length;

  return (
    <div className="border-b border-zinc-900 last:border-b-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="sticky top-[22px] z-[1] flex w-full items-center gap-1.5 border-y border-zinc-800/70 bg-zinc-900/95 px-2 py-1 text-left text-[11px] backdrop-blur-sm hover:bg-zinc-800/90"
        title={section.title}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-zinc-500" />
        )}
        <span className="truncate font-mono text-zinc-200">{section.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums">
          {section.binary && <span className="text-zinc-400">binary</span>}
          {section.adds > 0 && <span className="text-emerald-400">+{section.adds}</span>}
          {section.dels > 0 && <span className="text-rose-400">−{section.dels}</span>}
        </span>
      </button>
      {lines.map((l, i) => (
        <div key={i} className={`flex whitespace-pre px-2 ${LINE_CLASS[l.kind]}`}>
          {l.kind === "meta" || l.kind === "hunk" ? (
            <span className="sticky left-0 inline-block w-[5.375rem] shrink-0 select-none bg-zinc-950/95" />
          ) : (
            <Gutter line={l} />
          )}
          <span>{l.text || " "}</span>
        </div>
      ))}
      {open && hidden > 0 && (
        <button
          onClick={() => setShown((s) => s + PAGE_LINES)}
          className="block w-full px-2 py-1 text-left text-[11px] italic text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
        >
          … show more ({hidden} hidden lines)
        </button>
      )}
    </div>
  );
}

export function DiffView({
  diff,
  className,
}: {
  diff: string;
  className?: string;
}) {
  const sections = useMemo(() => parseSections(diff), [diff]);

  if (!diff.trim()) {
    return (
      <div className="px-3 py-4 text-[11px] text-zinc-400">No changes.</div>
    );
  }

  const totalAdds = sections.reduce((n, s) => n + s.adds, 0);
  const totalDels = sections.reduce((n, s) => n + s.dels, 0);

  return (
    <div className={`overflow-auto ${className ?? ""}`}>
      <div className="w-max min-w-full font-mono text-[13px] leading-[1.55]">
        {/* Diffstat summary — sticky so totals stay visible while scrolling. */}
        <div className="sticky top-0 z-[2] flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/95 px-2 py-1 text-[11px] tabular-nums backdrop-blur-sm">
          <span className="text-zinc-400">
            {sections.length} file{sections.length === 1 ? "" : "s"}
          </span>
          <span className="text-emerald-400">+{totalAdds}</span>
          <span className="text-rose-400">−{totalDels}</span>
        </div>
        {sections.map((s, i) => (
          <FileSectionView key={`${s.title}:${i}`} section={s} />
        ))}
      </div>
    </div>
  );
}

import { Button as UiButton } from "@/components/ui/button";
import { ControlTrigger } from "@/components/ui/control-trigger";
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
import { DiffLineItem } from "@/components/ui/item";

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
    <span className="sticky left-0 shrink-0 select-none bg-zinc-950/95 pr-2 text-right text-content-muted">
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
      <ControlTrigger controlWidth="fill"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${section.title}`}
        controlSize="regular" className="sticky top-[22px] z-[1] flex items-center gap-2 border-y border-zinc-800/70 bg-zinc-900/95 text-left  backdrop-blur-sm hover:bg-zinc-800/90"
        title={section.title}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-content-muted" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-content-muted" />
        )}
        <span className="truncate font-code text-content-secondary">{section.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
          {section.binary && <span className="text-content-muted">binary</span>}
          {section.adds > 0 && <span className="text-success-400">+{section.adds}</span>}
          {section.dels > 0 && <span className="text-removed-400">−{section.dels}</span>}
        </span>
      </ControlTrigger>
      {lines.map((l, i) => (
        <DiffLineItem key={i}
          controlSize="compact"
          tone={l.kind === "add" ? "add" : l.kind === "del" ? "remove" : "context"}
          marker={l.kind === "meta" || l.kind === "hunk" ? (
            <span className="sticky left-0 inline-block w-[5.375rem] shrink-0 select-none bg-zinc-950/95" />
          ) : (
            <Gutter line={l} />
          )}
          content={l.text || " "}
        />
      ))}
      {open && hidden > 0 && (
        <ControlTrigger controlWidth="fill"
          onClick={() => setShown((s) => s + PAGE_LINES)}
          controlSize="regular" className="block text-left  italic text-content-primary hover:bg-zinc-900 hover:text-content-strong"
        >
          … show more ({hidden} hidden lines)
        </ControlTrigger>
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
      <div className="px-3 py-4 text-compact text-content-muted">No changes.</div>
    );
  }

  const totalAdds = sections.reduce((n, s) => n + s.adds, 0);
  const totalDels = sections.reduce((n, s) => n + s.dels, 0);

  return (
    <div className={`overflow-auto ${className ?? ""}`}>
      <div className="w-max min-w-full font-code text-regular leading-regular">
        {/* Diffstat summary — sticky so totals stay visible while scrolling. */}
        <div className="sticky top-0 z-[2] flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/95 px-2 py-1 text-compact tabular-nums backdrop-blur-sm">
          <span className="text-content-muted">
            {sections.length} file{sections.length === 1 ? "" : "s"}
          </span>
          <span className="text-success-400">+{totalAdds}</span>
          <span className="text-removed-400">−{totalDels}</span>
        </div>
        {sections.map((s, i) => (
          <FileSectionView key={`${s.title}:${i}`} section={s} />
        ))}
      </div>
    </div>
  );
}

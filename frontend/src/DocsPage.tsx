import { useEffect, useState, useRef } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";

const API = "/api";

type DocFile = { name: string; stem: string; size: number };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// ── Minimal markdown → HTML renderer (no external library) ───────────────────
function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let inList = false;
  let listOrdered = false;

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const inline = (s: string): string =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code class="bg-gray-100 px-1 rounded text-sm font-mono">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2" target="_blank" rel="noreferrer" class="text-blue-600 underline hover:text-blue-800">$1</a>'
      );

  const flushList = () => {
    if (inList) {
      out.push(listOrdered ? "</ol>" : "</ul>");
      inList = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // Fenced code block
    if (raw.startsWith("```")) {
      if (!inCode) {
        flushList();
        inCode = true;
        codeBuf = [];
      } else {
        out.push(
          `<pre class="bg-gray-900 text-gray-100 rounded-lg p-4 overflow-x-auto my-3 text-sm font-mono leading-relaxed"><code>${esc(codeBuf.join("\n"))}</code></pre>`
        );
        inCode = false;
        codeBuf = [];
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(raw.trim()) || /^\*\*\*+$/.test(raw.trim())) {
      flushList();
      out.push('<hr class="my-4 border-gray-300" />');
      continue;
    }

    // Headings
    const h = raw.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      flushList();
      const level = h[1].length;
      const text = inline(h[2]);
      const sizes = ["text-2xl", "text-xl", "text-lg", "text-base", "text-sm", "text-xs"];
      const weights = level <= 2 ? "font-bold" : "font-semibold";
      const margins = level === 1 ? "mt-6 mb-3" : level === 2 ? "mt-5 mb-2" : "mt-4 mb-1";
      const border = level === 1 ? " pb-2 border-b border-gray-200" : level === 2 ? " pb-1 border-b border-gray-100" : "";
      out.push(`<h${level} class="${sizes[level - 1]} ${weights} ${margins} text-gray-900${border}">${text}</h${level}>`);
      continue;
    }

    // Blockquote
    if (raw.startsWith("> ")) {
      flushList();
      out.push(
        `<blockquote class="border-l-4 border-blue-400 bg-blue-50 pl-4 pr-2 py-1 my-2 text-gray-700 italic text-sm">${inline(raw.slice(2))}</blockquote>`
      );
      continue;
    }

    // Ordered list
    const ol = raw.match(/^(\d+)\.\s+(.*)/);
    if (ol) {
      if (!inList || !listOrdered) {
        flushList();
        out.push('<ol class="list-decimal pl-6 my-2 space-y-0.5 text-gray-800 text-sm">');
        inList = true;
        listOrdered = true;
      }
      out.push(`<li>${inline(ol[2])}</li>`);
      continue;
    }

    // Unordered list
    const ul = raw.match(/^[-*+]\s+(.*)/);
    if (ul) {
      if (!inList || listOrdered) {
        flushList();
        out.push('<ul class="list-disc pl-6 my-2 space-y-0.5 text-gray-800 text-sm">');
        inList = true;
        listOrdered = false;
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    // Empty line
    if (raw.trim() === "") {
      flushList();
      out.push('<div class="my-1"></div>');
      continue;
    }

    // Paragraph
    flushList();
    out.push(`<p class="text-sm text-gray-800 leading-relaxed my-1">${inline(raw)}</p>`);
  }

  if (inCode && codeBuf.length) {
    out.push(`<pre class="bg-gray-900 text-gray-100 rounded-lg p-4 overflow-x-auto my-3 text-sm font-mono"><code>${esc(codeBuf.join("\n"))}</code></pre>`);
  }
  flushList();
  return out.join("\n");
}

// ── Table of Contents extractor ───────────────────────────────────────────────
type TocEntry = { level: number; text: string; id: string };

function extractToc(md: string): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^(#{1,3})\s+(.*)/);
    if (m) {
      const text = m[2].replace(/\*\*|__|`/g, "").trim();
      const id = text.toLowerCase().replace(/\s+/g, "-").replace(/[^\w\u4e00-\u9fff-]/g, "");
      entries.push({ level: m[1].length, text, id });
    }
  }
  return entries;
}

// ── Main Component ─────────────────────────────────────────────────────────────
export default function DocsPage() {
  const [files, setFiles] = useState<DocFile[]>([]);
  const [selected, setSelected] = useState<DocFile | null>(null);
  const [content, setContent] = useState("");
  const [editContent, setEditContent] = useState("");
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [tocOpen, setTocOpen] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);

  // Load file list
  useEffect(() => {
    fetch(`${API}/docs`)
      .then((r) => r.json())
      .then((d) => {
        if (d.files) setFiles(d.files);
      })
      .catch(() => toast.error("Failed to load docs list"));
  }, []);

  // Load file content
  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    setContent("");
    setEditContent("");
    fetch(`${API}/docs/raw/${encodeURIComponent(selected.stem)}`)
      .then((r) => r.json())
      .then((d) => {
        setContent(d.content ?? "");
        setEditContent(d.content ?? "");
      })
      .catch(() => toast.error("Failed to load file"))
      .finally(() => setLoading(false));
  }, [selected]);

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const r = await fetch(`${API}/docs/raw/${encodeURIComponent(selected.stem)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });
      const d = await r.json();
      if (d.status === "ok") {
        setContent(editContent);
        toast.success("Saved");
        setMode("preview");
      } else {
        toast.error("Save failed");
      }
    } catch {
      toast.error("Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setEditContent(content);
    setMode("preview");
  };

  const filtered = files.filter((f) =>
    f.stem.toLowerCase().includes(search.toLowerCase())
  );

  const toc = content ? extractToc(content) : [];
  const htmlContent = content ? renderMarkdown(content) : "";
  const wordCount = content.trim() ? content.trim().split(/\s+/).length : 0;

  return (
    <div className="flex h-screen bg-gray-50 font-sans text-gray-900">
      {/* ── Left sidebar ── */}
      <aside className="w-64 flex-shrink-0 bg-white border-r border-gray-200 flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-base text-gray-900">Docs</span>
            <Link
              to="/"
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              ← Back
            </Link>
          </div>
          <input
            type="text"
            placeholder="Search files…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full text-xs border border-gray-200 rounded-md px-2.5 py-1.5 focus:outline-none focus:border-blue-400"
          />
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <p className="text-xs text-gray-400 px-4 py-3">No files found.</p>
          )}
          {filtered.map((f) => (
            <button
              key={f.name}
              onClick={() => { setSelected(f); setMode("preview"); }}
              className={`w-full text-left px-4 py-2.5 text-sm transition-colors flex flex-col gap-0.5 ${
                selected?.name === f.name
                  ? "bg-blue-50 text-blue-700 border-r-2 border-blue-500"
                  : "text-gray-700 hover:bg-gray-50"
              }`}
            >
              <span className="truncate font-medium">{f.stem}</span>
              <span className="text-xs text-gray-400">{formatSize(f.size)}</span>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-gray-200">
          <p className="text-xs text-gray-400">{files.length} files</p>
        </div>
      </aside>

      {/* ── Main content ── */}
      <main className="flex-1 flex flex-col min-w-0">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-gray-400">
              <div className="text-5xl mb-3">📄</div>
              <p className="text-base font-medium">Select a document</p>
              <p className="text-sm mt-1">Choose a file from the sidebar to view or edit.</p>
            </div>
          </div>
        ) : (
          <>
            {/* Toolbar */}
            <div className="flex items-center justify-between px-6 py-3 bg-white border-b border-gray-200 flex-shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <h1 className="text-base font-semibold text-gray-900 truncate">
                  {selected.stem}
                </h1>
                {content && (
                  <span className="text-xs text-gray-400 flex-shrink-0">
                    {wordCount.toLocaleString()} words · {formatSize(selected.size)}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                {/* TOC toggle */}
                {toc.length > 0 && mode === "preview" && (
                  <button
                    onClick={() => setTocOpen((o) => !o)}
                    className="text-xs px-2.5 py-1.5 rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50"
                  >
                    TOC
                  </button>
                )}

                {/* Mode toggle */}
                <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
                  <button
                    onClick={() => setMode("preview")}
                    className={`px-3 py-1.5 ${mode === "preview" ? "bg-blue-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
                  >
                    Preview
                  </button>
                  <button
                    onClick={() => setMode("edit")}
                    className={`px-3 py-1.5 border-l border-gray-200 ${mode === "edit" ? "bg-blue-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
                  >
                    Edit
                  </button>
                </div>

                {/* Edit actions */}
                {mode === "edit" && (
                  <>
                    <button
                      onClick={handleDiscard}
                      className="text-xs px-3 py-1.5 rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50"
                    >
                      Discard
                    </button>
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {saving ? "Saving…" : "Save"}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 flex min-h-0">
              {loading ? (
                <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                  Loading…
                </div>
              ) : mode === "edit" ? (
                /* Edit mode */
                <div className="flex-1 flex flex-col p-4">
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="flex-1 w-full font-mono text-sm border border-gray-200 rounded-lg p-4 resize-none focus:outline-none focus:border-blue-400 bg-white leading-relaxed"
                    spellCheck={false}
                  />
                </div>
              ) : (
                /* Preview mode */
                <div className="flex-1 flex min-w-0">
                  <div
                    ref={previewRef}
                    className="flex-1 overflow-y-auto px-10 py-6 min-w-0"
                    dangerouslySetInnerHTML={{ __html: htmlContent }}
                  />

                  {/* Table of Contents panel */}
                  {tocOpen && toc.length > 0 && (
                    <aside className="w-56 flex-shrink-0 border-l border-gray-200 bg-white overflow-y-auto py-4 px-3">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                        Contents
                      </p>
                      <nav className="space-y-0.5">
                        {toc.map((entry, i) => (
                          <button
                            key={i}
                            onClick={() => {
                              previewRef.current
                                ?.querySelector(`[id="${entry.id}"]`)
                                ?.scrollIntoView({ behavior: "smooth" });
                            }}
                            className={`w-full text-left text-xs py-0.5 text-gray-600 hover:text-blue-600 truncate ${
                              entry.level === 1 ? "font-semibold" : entry.level === 2 ? "pl-3" : "pl-6 text-gray-400"
                            }`}
                          >
                            {entry.text}
                          </button>
                        ))}
                      </nav>
                    </aside>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

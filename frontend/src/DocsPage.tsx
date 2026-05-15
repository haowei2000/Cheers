import { useEffect, useState, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { AppIcon } from "./components/icons";

const API = "/api";  // docs 端点由 manual_routes 提供，路径不含 /v1

type DocFile = { name: string; stem: string; size: number; category?: string };

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
  const [urlParams, setUrlParams] = useSearchParams();
  const selectedStemFromUrl = urlParams.get("file");
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setSidebarOpen(false);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

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

  useEffect(() => {
    if (!files.length) return;
    if (!selectedStemFromUrl) {
      if (selected) setSelected(null);
      return;
    }
    if (selected?.stem === selectedStemFromUrl) return;
    const hit = files.find((f) => f.stem === selectedStemFromUrl);
    if (hit) setSelected(hit);
  }, [files, selected?.stem, selectedStemFromUrl]);

  useEffect(() => {
    const current = urlParams.get("file");
    const next = selected?.stem ?? null;
    if (current === next) return;
    const params = new URLSearchParams(urlParams);
    if (next) {
      params.set("file", next);
    } else {
      params.delete("file");
    }
    setUrlParams(params, { replace: true });
  }, [selected?.stem, setUrlParams, urlParams]);

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
      if (d.status === "success") {
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

  const filtered = files.filter((f) => {
    const q = search.toLowerCase();
    return f.stem.toLowerCase().includes(q) || f.name.toLowerCase().includes(q);
  });

  const toc = content ? extractToc(content) : [];
  const htmlContent = content ? renderMarkdown(content) : "";
  const wordCount = content.trim() ? content.trim().split(/\s+/).length : 0;

  return (
    <div className="flex h-screen flex-col bg-gray-50 font-sans text-gray-900 overflow-hidden">
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4 flex-shrink-0">
        <Link to="/" className="text-gray-500 hover:text-gray-800 text-sm flex items-center gap-1">
          <AppIcon name="arrowLeft" className="w-4 h-4" />
          返回
        </Link>
        <h1 className="text-lg font-semibold text-gray-800">文档</h1>
        <span className="text-xs text-gray-400 ml-1">Docs</span>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {isMobile && sidebarOpen && (
          <div className="fixed inset-0 bg-black/40 z-[65]" onClick={() => setSidebarOpen(false)} />
        )}
        {/* ── Left sidebar ── */}
        <aside className={`bg-white border-r border-gray-200 flex flex-col flex-shrink-0 ${isMobile ? "fixed inset-y-0 left-0 z-[70] w-64 transition-transform duration-300 ease-in-out shadow-xl" : "w-64"} ${isMobile && !sidebarOpen ? "-translate-x-full" : "translate-x-0"}`}>
          {/* Header */}
          <div className="px-4 py-3 border-b border-gray-200">
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-base text-gray-900">文档列表</span>
            </div>
            <input
              type="text"
              placeholder="搜索文档..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full text-xs border border-gray-200 rounded-md px-2.5 py-1.5 focus:outline-none focus:border-blue-400"
            />
          </div>

          {/* File list */}
          <div className="flex-1 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <p className="text-xs text-gray-400 px-4 py-3">未找到文件。</p>
            )}
            {filtered.map((f) => {
              const basename = f.stem.includes("/") ? f.stem.split("/").pop()! : f.stem;
              const categoryLabel = f.category === "help" ? "用户" : f.category === "develop" ? "开发" : "";
              return (
                <button
                  key={f.stem}
                  onClick={() => { setSelected(f); setMode("preview"); if (isMobile) setSidebarOpen(false); }}
                  className={`w-full text-left px-4 py-2.5 text-sm transition-colors flex flex-col gap-0.5 ${
                    selected?.stem === f.stem
                      ? "bg-blue-50 text-blue-700 border-r-2 border-blue-500"
                      : "text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  <span className="truncate font-medium">{basename}</span>
                  <span className="text-xs text-gray-400 flex items-center gap-1.5">
                    {categoryLabel && (
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                        f.category === "help" ? "bg-green-100 text-green-700" : "bg-purple-100 text-purple-700"
                      }`}>{categoryLabel}</span>
                    )}
                    <span>{formatSize(f.size)}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-gray-200">
            <p className="text-xs text-gray-400">{files.length} 个文件</p>
          </div>
        </aside>

        {/* ── Main content ── */}
        <main className="flex-1 flex flex-col min-w-0 bg-white">
          {!selected ? (
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
              {isMobile && (
                <button onClick={() => setSidebarOpen(true)} className="mb-8 px-4 py-2 border border-gray-200 rounded-lg text-sm text-blue-600 font-medium">
                  浏览文件
                </button>
              )}
              <div className="text-gray-400">
                <div className="text-5xl mb-3 text-gray-300">📄</div>
                <p className="text-base font-medium text-gray-600">选择一个文档</p>
                <p className="text-sm mt-1">从侧边栏选择一个文件以查看或编辑。</p>
              </div>
            </div>
          ) : (
            <>
              {/* Toolbar */}
              <div className="flex items-center justify-between px-4 sm:px-6 py-3 bg-white border-b border-gray-200 flex-shrink-0">
                <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                  {isMobile && (
                    <button onClick={() => setSidebarOpen(true)} className="p-1 -ml-1 text-gray-400 hover:text-gray-600">
                      <AppIcon name="menu" className="w-6 h-6" />
                    </button>
                  )}
                  <h1 className="text-base font-semibold text-gray-900 truncate">
                    {selected.stem.includes("/") ? selected.stem.split("/").pop() : selected.stem}
                  </h1>
                  {!isMobile && content && (
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
                      className={`text-xs px-2.5 py-1.5 rounded-md border transition-colors ${tocOpen ? "bg-blue-50 border-blue-200 text-blue-600" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}
                    >
                      目录
                    </button>
                  )}

                  {/* Mode toggle */}
                  <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
                    <button
                      onClick={() => setMode("preview")}
                      className={`px-3 py-1.5 ${mode === "preview" ? "bg-blue-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
                    >
                      查看
                    </button>
                    <button
                      onClick={() => setMode("edit")}
                      className={`px-3 py-1.5 border-l border-gray-200 ${mode === "edit" ? "bg-blue-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
                    >
                      编辑
                    </button>
                  </div>

                  {/* Edit actions */}
                  {mode === "edit" && (
                    <>
                      <button
                        onClick={handleDiscard}
                        className="hidden sm:block text-xs px-3 py-1.5 rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50"
                      >
                        放弃
                      </button>
                      <button
                        onClick={handleSave}
                        disabled={saving}
                        className="text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {saving ? "…" : "保存"}
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Body */}
              <div className="flex-1 flex min-h-0 relative">
                {loading ? (
                  <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                    加载中…
                  </div>
                ) : mode === "edit" ? (
                  /* Edit mode */
                  <div className="flex-1 flex flex-col p-4 bg-gray-50">
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className="flex-1 w-full font-mono text-sm border border-gray-200 rounded-lg p-4 resize-none focus:outline-none focus:border-blue-400 bg-white leading-relaxed shadow-sm"
                      spellCheck={false}
                    />
                  </div>
                ) : (
                  /* Preview mode */
                  <div className="flex-1 flex min-w-0">
                    <div
                      ref={previewRef}
                      className="flex-1 overflow-y-auto px-6 sm:px-10 py-6 min-w-0 scroll-smooth"
                      dangerouslySetInnerHTML={{ __html: htmlContent }}
                    />

                    {/* Table of Contents panel */}
                    {tocOpen && toc.length > 0 && (
                      <>
                        {isMobile && (
                          <div className="fixed inset-0 bg-black/20 z-[75]" onClick={() => setTocOpen(false)} />
                        )}
                        <aside className={`${isMobile ? "fixed inset-y-0 right-0 z-[80] shadow-2xl w-64" : "w-56 border-l"} flex-shrink-0 border-gray-200 bg-white overflow-y-auto py-4 px-3`}>
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                              目录
                            </p>
                            {isMobile && (
                              <button onClick={() => setTocOpen(false)} className="text-gray-400">×</button>
                            )}
                          </div>
                          <nav className="space-y-0.5">
                            {toc.map((entry, i) => (
                              <button
                                key={i}
                                onClick={() => {
                                  previewRef.current
                                    ?.querySelector(`[id="${entry.id}"]`)
                                    ?.scrollIntoView({ behavior: "smooth" });
                                  if (isMobile) setTocOpen(false);
                                }}
                                className={`w-full text-left text-xs py-1 text-gray-600 hover:text-blue-600 truncate ${
                                  entry.level === 1 ? "font-semibold" : entry.level === 2 ? "pl-3" : "pl-6 text-gray-400"
                                }`}
                              >
                                {entry.text}
                              </button>
                            ))}
                          </nav>
                        </aside>
                      </>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

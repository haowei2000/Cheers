import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AppIcon } from "./components/icons/AppIcon";

const API = "/api";  // Docs endpoints are provided by manual_routes and omit /v1.

type DocFile = { name: string; stem: string; size: number; category?: string };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// ── Table of Contents extractor ───────────────────────────────────────────────
type TocEntry = { level: number; text: string; id: string };

function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u4e00-\u9fff-]/g, "");
}

function extractToc(md: string): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^(#{1,3})\s+(.*)/);
    if (m) {
      const text = m[2].replace(/\*\*|__|`/g, "").trim();
      const id = slugifyHeading(text);
      entries.push({ level: m[1].length, text, id });
    }
  }
  return entries;
}

function childrenToText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(childrenToText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return childrenToText((children as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

function sanitizeMarkdownUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("#")) return trimmed;
  try {
    const parsed = new URL(trimmed, window.location.origin);
    if (["http:", "https:", "mailto:"].includes(parsed.protocol)) return trimmed;
  } catch {
    /* fall through */
  }
  if (/^(\/(?!\/)|\.{1,2}\/)/.test(trimmed)) return trimmed;
  return "";
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
                    >
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        urlTransform={sanitizeMarkdownUrl}
                        components={{
                          code({ className, children, ...props }) {
                            const inline = !className && !String(children).includes("\n");
                            return inline ? (
                              <code className="bg-gray-100 px-1 rounded text-sm font-mono" {...props}>
                                {children}
                              </code>
                            ) : (
                              <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 overflow-x-auto my-3 text-sm font-mono leading-relaxed">
                                <code className={className}>{children}</code>
                              </pre>
                            );
                          },
                          a({ href, children, ...props }) {
                            const safeHref = sanitizeMarkdownUrl(href || "");
                            const external = /^https?:\/\//i.test(safeHref);
                            return (
                              <a
                                href={safeHref || "#"}
                                target={external ? "_blank" : undefined}
                                rel={external ? "noreferrer" : undefined}
                                className="text-blue-600 underline hover:text-blue-800"
                                {...props}
                              >
                                {children}
                              </a>
                            );
                          },
                          h1({ children, ...props }) {
                            return (
                              <h1 id={slugifyHeading(childrenToText(children))} className="text-2xl font-bold mt-6 mb-3 text-gray-900 pb-2 border-b border-gray-200" {...props}>
                                {children}
                              </h1>
                            );
                          },
                          h2({ children, ...props }) {
                            return (
                              <h2 id={slugifyHeading(childrenToText(children))} className="text-xl font-bold mt-5 mb-2 text-gray-900 pb-1 border-b border-gray-100" {...props}>
                                {children}
                              </h2>
                            );
                          },
                          h3({ children, ...props }) {
                            return (
                              <h3 id={slugifyHeading(childrenToText(children))} className="text-lg font-semibold mt-4 mb-1 text-gray-900" {...props}>
                                {children}
                              </h3>
                            );
                          },
                          h4({ children, ...props }) {
                            return <h4 className="text-base font-semibold mt-4 mb-1 text-gray-900" {...props}>{children}</h4>;
                          },
                          h5({ children, ...props }) {
                            return <h5 className="text-sm font-semibold mt-4 mb-1 text-gray-900" {...props}>{children}</h5>;
                          },
                          h6({ children, ...props }) {
                            return <h6 className="text-xs font-semibold mt-4 mb-1 text-gray-900" {...props}>{children}</h6>;
                          },
                          p({ children, ...props }) {
                            return <p className="text-sm text-gray-800 leading-relaxed my-1" {...props}>{children}</p>;
                          },
                          ul({ children, ...props }) {
                            return <ul className="list-disc pl-6 my-2 space-y-0.5 text-gray-800 text-sm" {...props}>{children}</ul>;
                          },
                          ol({ children, ...props }) {
                            return <ol className="list-decimal pl-6 my-2 space-y-0.5 text-gray-800 text-sm" {...props}>{children}</ol>;
                          },
                          blockquote({ children, ...props }) {
                            return (
                              <blockquote className="border-l-4 border-blue-400 bg-blue-50 pl-4 pr-2 py-1 my-2 text-gray-700 italic text-sm" {...props}>
                                {children}
                              </blockquote>
                            );
                          },
                          hr() {
                            return <hr className="my-4 border-gray-300" />;
                          },
                        }}
                      >
                        {content}
                      </ReactMarkdown>
                    </div>

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

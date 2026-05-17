import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AppIcon } from "./components/icons/AppIcon";

const API = "/api";  // Docs endpoints are provided by manual_routes and omit /v1.

type DocFile = { name: string; stem: string; size: number; category?: string };
const PREFERRED_DOC_STEMS = ["help/README"];

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

function resolveDocLinkStem(
  href: string,
  currentStem: string,
  docs: DocFile[],
): string | null {
  const pathPart = href.split("#", 1)[0].trim();
  if (!pathPart || !/\.md$/i.test(pathPart)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathPart) || pathPart.startsWith("/")) {
    return null;
  }

  const decoded = decodeURIComponent(pathPart);
  const bare = decoded.replace(/\.md$/i, "").replace(/^\.\//, "");
  if (docs.some((doc) => doc.stem === bare)) return bare;

  const stack = currentStem.includes("/") ? currentStem.split("/").slice(0, -1) : [];
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  const candidate = stack.join("/").replace(/\.md$/i, "");
  return docs.some((doc) => doc.stem === candidate) ? candidate : null;
}

// ── Main Component ─────────────────────────────────────────────────────────────
export default function DocsPage() {
  const [urlParams, setUrlParams] = useSearchParams();
  const selectedStemFromUrl = urlParams.get("file");
  const canEdit = urlParams.get("edit") === "1";
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
  const readableFiles = useMemo(() => {
    const helpDocs = files.filter((file) => file.category === "help");
    if (helpDocs.length > 0) return helpDocs;
    return files.filter((file) => file.category !== "develop");
  }, [files]);

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
    if (!selectedStemFromUrl) return;
    if (selected?.stem === selectedStemFromUrl) return;
    const hit = readableFiles.find((f) => f.stem === selectedStemFromUrl);
    if (hit) setSelected(hit);
  }, [files.length, readableFiles, selected?.stem, selectedStemFromUrl]);

  useEffect(() => {
    if (selected || selectedStemFromUrl || readableFiles.length === 0) return;
    const preferred =
      PREFERRED_DOC_STEMS
        .map((stem) => readableFiles.find((file) => file.stem === stem))
        .find(Boolean) ?? readableFiles[0];
    if (preferred) setSelected(preferred);
  }, [readableFiles, selected, selectedStemFromUrl]);

  useEffect(() => {
    if (!canEdit && mode === "edit") setMode("preview");
  }, [canEdit, mode]);

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

  const filtered = readableFiles.filter((f) => {
    const q = search.toLowerCase();
    return f.stem.toLowerCase().includes(q) || f.name.toLowerCase().includes(q);
  });

  const toc = content ? extractToc(content) : [];
  const wordCount = content.trim() ? content.trim().split(/\s+/).length : 0;

  return (
    <div className="an-token-page flex h-screen flex-col overflow-hidden font-sans">
      <header className="flex flex-shrink-0 items-center gap-4 border-b border-[var(--border)] bg-[var(--bg-1)] px-6 py-3">
        <Link to="/" className="an-btn an-btn-ghost an-btn-sm">
          <AppIcon name="arrowLeft" className="w-4 h-4" />
          Back
        </Link>
        <h1 className="an-type-title">User Docs</h1>
        <span className="an-type-meta ml-1">User guides and operations manuals</span>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {isMobile && sidebarOpen && (
          <div className="fixed inset-0 bg-black/40 z-[65]" onClick={() => setSidebarOpen(false)} />
        )}
        {/* ── Left sidebar ── */}
        <aside className={`flex flex-shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-1)] ${isMobile ? "fixed inset-y-0 left-0 z-[70] w-64 shadow-xl transition-transform duration-300 ease-in-out" : "w-64"} ${isMobile && !sidebarOpen ? "-translate-x-full" : "translate-x-0"}`}>
          {/* Header */}
          <div className="border-b border-[var(--border)] px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="an-type-label">User docs</span>
            </div>
            <input
              type="text"
              placeholder="Search docs..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="an-input"
            />
          </div>

          {/* File list */}
          <div className="flex-1 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <p className="an-type-meta px-4 py-3">No files found.</p>
            )}
            {filtered.map((f) => {
              const basename = f.stem.includes("/") ? f.stem.split("/").pop()! : f.stem;
              const categoryLabel = f.category === "help" ? "User" : f.category === "develop" ? "Develop" : "";
              return (
                <button
                  key={f.stem}
                  onClick={() => { setSelected(f); setMode("preview"); if (isMobile) setSidebarOpen(false); }}
	                  className={`flex w-full flex-col gap-0.5 px-4 py-2.5 text-left transition-colors ${
	                    selected?.stem === f.stem
	                      ? "border-r-2 border-[var(--accent)] bg-[var(--accent-muted)] text-[var(--accent)]"
	                      : "text-[var(--fg-2)] hover:bg-[var(--surface-soft)]"
	                  }`}
	                >
	                  <span className="an-type-body truncate font-medium">{basename}</span>
	                  <span className="an-type-caption flex items-center gap-1.5">
	                    {categoryLabel && (
	                      <span className={`an-chip ${
	                        f.category === "help" ? "green" : "blue"
	                      }`}>{categoryLabel}</span>
	                    )}
                    <span>{formatSize(f.size)}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* Footer */}
          <div className="border-t border-[var(--border)] px-4 py-2">
            <p className="an-type-meta">{readableFiles.length} files</p>
          </div>
        </aside>

        {/* ── Main content ── */}
        <main className="flex min-w-0 flex-1 flex-col bg-[var(--bg-1)]">
          {!selected ? (
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
              {isMobile && (
                <button type="button" onClick={() => setSidebarOpen(true)} className="an-btn an-btn-primary mb-8">
                  Browse files
                </button>
              )}
              <div>
                <div className="mb-3 inline-grid h-14 w-14 place-items-center rounded-lg bg-[var(--surface-soft)] text-[var(--fg-3)]">
                  <AppIcon name="file" className="h-7 w-7" />
                </div>
                <p className="an-type-body font-medium">Select a document</p>
                <p className="an-type-meta mt-1">Select a user guide from the sidebar to read.</p>
              </div>
            </div>
          ) : (
            <>
              {/* Toolbar */}
              <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--bg-1)] px-4 py-3 sm:px-6">
                <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                  {isMobile && (
                    <button type="button" onClick={() => setSidebarOpen(true)} className="an-btn an-btn-ghost an-btn-icon -ml-1">
                      <AppIcon name="menu" className="w-6 h-6" />
                    </button>
                  )}
                  <h1 className="an-type-title truncate">
                    {selected.stem.includes("/") ? selected.stem.split("/").pop() : selected.stem}
                  </h1>
                  {!isMobile && content && (
                    <span className="an-type-meta flex-shrink-0">
                      {wordCount.toLocaleString()} words · {formatSize(selected.size)}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  {/* TOC toggle */}
                  {toc.length > 0 && mode === "preview" && (
                    <button
                      onClick={() => setTocOpen((o) => !o)}
                      className={`an-btn an-btn-sm ${tocOpen ? "an-btn-primary" : ""}`}
                    >
                      Table of contents
                    </button>
                  )}

                  {canEdit && (
                    <div className="an-seg">
                      <button
                        type="button"
                        onClick={() => setMode("preview")}
                        className={mode === "preview" ? "on" : ""}
                      >
                        View
                      </button>
                      <button
                        type="button"
                        onClick={() => setMode("edit")}
                        className={mode === "edit" ? "on" : ""}
                      >
                        Edit
                      </button>
                    </div>
                  )}

                  {/* Edit actions */}
                  {mode === "edit" && (
                    <>
                      <button
                        type="button"
                        onClick={handleDiscard}
                        className="an-btn an-btn-sm hidden sm:inline-flex"
                      >
                        Discard
                      </button>
                      <button
                        type="button"
                        onClick={handleSave}
                        disabled={saving}
                        className="an-btn an-btn-primary an-btn-sm"
                      >
                        {saving ? "..." : "Save"}
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Body */}
              <div className="flex-1 flex min-h-0 relative">
                {loading ? (
                  <div className="an-type-meta flex flex-1 items-center justify-center">
                    Loading...
                  </div>
                ) : mode === "edit" ? (
                  /* Edit mode */
                  <div className="flex flex-1 flex-col bg-[var(--bg-0)] p-4">
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className="an-textarea flex-1 resize-none font-mono leading-relaxed"
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
	                              <code className="rounded bg-[var(--surface-soft)] px-1 font-mono text-[var(--fg-1)]" {...props}>
	                                {children}
	                              </code>
	                            ) : (
	                              <pre className="my-3 overflow-x-auto rounded-md bg-[var(--bg-2)] p-4 font-mono leading-relaxed text-[var(--fg-1)]">
	                                <code className={className}>{children}</code>
                              </pre>
                            );
                          },
                          a({ href, children, ...props }) {
                            const safeHref = sanitizeMarkdownUrl(href || "");
                            const docStem = selected
                              ? resolveDocLinkStem(safeHref, selected.stem, readableFiles)
                              : null;
                            const external = /^https?:\/\//i.test(safeHref);
                            return (
                              <a
                                href={docStem ? `?file=${encodeURIComponent(docStem)}` : safeHref || "#"}
                                onClick={
                                  docStem
                                    ? (event) => {
                                        event.preventDefault();
                                        const next = readableFiles.find((file) => file.stem === docStem);
                                        if (next) {
                                          setSelected(next);
                                          setMode("preview");
                                        }
                                      }
                                    : undefined
                                }
                                target={external ? "_blank" : undefined}
                                rel={external ? "noreferrer" : undefined}
	                                className="text-[var(--accent)] underline hover:text-[var(--accent-hover)]"
                                {...props}
                              >
                                {children}
                              </a>
                            );
                          },
                          h1({ children, ...props }) {
                            return (
	                              <h1 id={slugifyHeading(childrenToText(children))} className="mb-3 mt-6 border-b border-[var(--border)] pb-2 text-xl font-bold text-[var(--fg-1)]" {...props}>
                                {children}
                              </h1>
                            );
                          },
                          h2({ children, ...props }) {
                            return (
	                              <h2 id={slugifyHeading(childrenToText(children))} className="mb-2 mt-5 border-b border-[var(--border)] pb-1 text-lg font-bold text-[var(--fg-1)]" {...props}>
                                {children}
                              </h2>
                            );
                          },
                          h3({ children, ...props }) {
                            return (
	                              <h3 id={slugifyHeading(childrenToText(children))} className="mb-1 mt-4 text-base font-semibold text-[var(--fg-1)]" {...props}>
                                {children}
                              </h3>
                            );
                          },
                          h4({ children, ...props }) {
                            return <h4 className="mb-1 mt-4 font-semibold text-[var(--fg-1)]" {...props}>{children}</h4>;
                          },
                          h5({ children, ...props }) {
                            return <h5 className="mb-1 mt-4 font-semibold text-[var(--fg-1)]" {...props}>{children}</h5>;
                          },
                          h6({ children, ...props }) {
                            return <h6 className="an-type-label mb-1 mt-4" {...props}>{children}</h6>;
                          },
                          p({ children, ...props }) {
                            return <p className="an-type-body my-1 leading-relaxed" {...props}>{children}</p>;
                          },
                          ul({ children, ...props }) {
                            return <ul className="an-type-body my-2 list-disc space-y-0.5 pl-6" {...props}>{children}</ul>;
                          },
                          ol({ children, ...props }) {
                            return <ol className="an-type-body my-2 list-decimal space-y-0.5 pl-6" {...props}>{children}</ol>;
                          },
                          blockquote({ children, ...props }) {
                            return (
	                              <blockquote className="an-type-body my-2 border-l-4 border-[var(--accent)] bg-[var(--accent-muted)] py-1 pl-4 pr-2 italic" {...props}>
                                {children}
                              </blockquote>
                            );
                          },
                          hr() {
                            return <hr className="my-4 border-[var(--border)]" />;
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
	                        <aside className={`${isMobile ? "fixed inset-y-0 right-0 z-[80] w-64 shadow-xl" : "w-56 border-l"} flex-shrink-0 overflow-y-auto border-[var(--border)] bg-[var(--bg-1)] px-3 py-4`}>
	                          <div className="flex items-center justify-between mb-2">
	                            <p className="an-type-caption font-semibold uppercase">
	                              Table of contents
                            </p>
                            {isMobile && (
                              <button
                                type="button"
                                onClick={() => setTocOpen(false)}
	                                className="an-btn an-btn-ghost an-btn-icon"
                                aria-label="Close table of contents"
                                title="Close table of contents"
                              >
                                <AppIcon name="close" className="h-4 w-4" />
                              </button>
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
	                                className={`w-full truncate py-1 text-left text-[var(--fg-2)] hover:text-[var(--accent)] ${
	                                  entry.level === 1 ? "font-semibold" : entry.level === 2 ? "pl-3" : "pl-6 text-[var(--fg-3)]"
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

import { useEffect, useId, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js";

// ── @mention preprocessing ───────────────────────────────────────────────────

/**
 * Replace @username patterns (outside code blocks/fences) with markdown links
 * using a `mention://` scheme so the custom `a` renderer can style them.
 */
function preprocessMentions(text: string): string {
  // Split on code fences (```…```) and inline code (`…`) to skip them
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((part, i) =>
      i % 2 === 1
        ? part // inside code — leave untouched
        : part.replace(/@([a-zA-Z0-9_\-'\u4e00-\u9fff]+)/g, "[@$1](mention://$1)")
    )
    .join("");
}

// ── AgentNexus file URL detection ────────────────────────────────────────────

/** Matches /api/files/{id}/preview|download (relative or absolute origin). */
const FILE_URL_RE = /(?:https?:\/\/[^/]+)?\/api\/files\/([^/]+)\/(preview|download)/;

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"]);

function fileIconColors(filename: string): { bg: string; fg: string } {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return { bg: "bg-red-50", fg: "text-red-500" };
  if (["doc", "docx"].includes(ext)) return { bg: "bg-blue-50", fg: "text-blue-500" };
  if (["xls", "xlsx", "csv"].includes(ext)) return { bg: "bg-green-50", fg: "text-green-600" };
  if (["md", "txt"].includes(ext)) return { bg: "bg-gray-50", fg: "text-gray-500" };
  if (IMAGE_EXTS.has(ext)) return { bg: "bg-purple-50", fg: "text-purple-500" };
  return { bg: "bg-blue-50", fg: "text-blue-500" };
}

function childrenToText(children: unknown): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map((c) => childrenToText(c)).join("");
  return "";
}

interface FileChipProps {
  href: string;
  fileId: string;
  filename: string;
  onImageClick?: (src: string) => void;
  onFileClick?: (url: string, filename: string) => void;
}

function FileChip({ href, fileId, filename, onImageClick, onFileClick }: FileChipProps) {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  const isImage = IMAGE_EXTS.has(ext);
  const previewUrl = href.replace(/\/(download|preview)$/, "/preview");
  const { bg, fg } = fileIconColors(filename);
  const displayName = filename && filename !== previewUrl ? filename : `file-${fileId.slice(0, 8)}`;

  const handleClick = () => {
    if (isImage && onImageClick) {
      onImageClick(previewUrl);
    } else if (onFileClick) {
      onFileClick(previewUrl, displayName);
    } else {
      window.open(previewUrl, "_blank", "noreferrer");
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-2 px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg shadow-sm max-w-full hover:bg-gray-50 active:bg-gray-100 transition-colors cursor-pointer my-0.5 align-middle"
    >
      <span className={`w-7 h-7 rounded-md ${bg} flex items-center justify-center flex-shrink-0`}>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-4 h-4 ${fg}`}>
          <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 16 6.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Z" />
        </svg>
      </span>
      <span className="text-[13px] font-medium text-gray-700 truncate">{displayName}</span>
    </button>
  );
}

// ── MermaidBlock ──────────────────────────────────────────────────────────────

interface MermaidBlockProps {
  code: string;
  streaming?: boolean;
}

function MermaidBlock({ code, streaming }: MermaidBlockProps) {
  const uid = useId().replace(/:/g, "");
  const id = `mermaid-${uid}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (streaming) {
      setSvg(null);
      setError(null);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, theme: "default" });
        const { svg: rendered } = await mermaid.render(id, code);
        setSvg(rendered);
        setError(null);
      } catch (e) {
        setError(String(e));
        setSvg(null);
      }
    }, 300);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [code, streaming, id]);

  if (streaming || (!svg && !error)) {
    return (
      <pre className="bg-gray-900 text-gray-100 rounded-lg p-3 my-2 text-xs font-mono overflow-x-auto leading-relaxed">
        <code>{code}</code>
      </pre>
    );
  }

  if (error) {
    return (
      <div className="my-2">
        <pre className="bg-gray-900 text-gray-100 rounded-lg p-3 text-xs font-mono overflow-x-auto leading-relaxed">
          <code>{code}</code>
        </pre>
        <p className="text-xs text-red-500 mt-1">Mermaid 渲染错误: {error}</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="my-2 overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: svg! }}
    />
  );
}

// ── MessageMarkdown ───────────────────────────────────────────────────────────

interface MessageMarkdownProps {
  text: string;
  streaming?: boolean;
  onImageClick?: (src: string) => void;
  onFileClick?: (url: string, filename: string) => void;
}

export function MessageMarkdown({ text, streaming, onImageClick, onFileClick }: MessageMarkdownProps) {
  const processedText = preprocessMentions(text);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code({ node: _node, className, children, ...props }: any) {
          const inline = !className && typeof children === "string" && !/\n/.test(String(children));
          const match = /language-(\w+)/.exec(className || "");
          const lang = match?.[1] ?? "";
          const codeText = String(children).replace(/\n$/, "");

          if (!inline && lang === "mermaid") {
            return <MermaidBlock code={codeText} streaming={streaming} />;
          }

          if (!inline) {
            let highlighted = codeText;
            try {
              if (lang && hljs.getLanguage(lang)) {
                highlighted = hljs.highlight(codeText, { language: lang, ignoreIllegals: true }).value;
              } else {
                highlighted = hljs.highlightAuto(codeText).value;
              }
            } catch {}
            return (
              <pre className="bg-gray-900 rounded-lg p-3 my-2 text-xs font-mono overflow-x-auto leading-relaxed">
                <code
                  className={`hljs${lang ? ` language-${lang}` : ""}`}
                  dangerouslySetInnerHTML={{ __html: highlighted }}
                />
              </pre>
            );
          }

          return (
            <code className="bg-gray-100 px-1 rounded text-xs font-mono" {...props}>
              {children}
            </code>
          );
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        img({ src, alt, ...props }: any) {
          const safe = src && (src.startsWith("/") || src.startsWith("http://") || src.startsWith("https://"));
          const safeSrc = safe ? src : "";
          return (
            <img
              src={safeSrc}
              alt={alt || "image"}
              className="max-w-full max-h-[400px] rounded-lg my-2 border border-gray-200 cursor-pointer hover:opacity-90 transition-opacity"
              loading="lazy"
              onClick={safeSrc && onImageClick ? () => onImageClick(safeSrc) : undefined}
              {...props}
            />
          );
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        a({ href, children, ...props }: any) {
          const raw = href ?? "";

          // @mention chip
          if (raw.startsWith("mention://")) {
            const username = raw.slice("mention://".length);
            return (
              <span className="inline-block bg-blue-100 text-blue-700 text-xs font-semibold px-1.5 py-0.5 rounded cursor-default">
                @{username}
              </span>
            );
          }

          const fileMatch = FILE_URL_RE.exec(raw);
          if (fileMatch) {
            const fileId = fileMatch[1];
            const filename = childrenToText(children);
            return (
              <FileChip
                href={raw}
                fileId={fileId}
                filename={filename}
                onImageClick={onImageClick}
                onFileClick={onFileClick}
              />
            );
          }
          const safe = raw.startsWith("/") || raw.startsWith("http://") || raw.startsWith("https://");
          return (
            <a
              href={safe ? raw : "#"}
              target="_blank"
              rel="noreferrer"
              className="text-[#1264A3] underline"
              {...props}
            >
              {children}
            </a>
          );
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        p({ children, ...props }: any) {
          return (
            <p className="text-sm text-gray-800 leading-relaxed my-0.5" {...props}>
              {children}
            </p>
          );
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        h1({ children, ...props }: any) {
          return <h1 className="text-lg font-bold mt-4 mb-1 text-gray-900 border-b border-gray-200 pb-1" {...props}>{children}</h1>;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        h2({ children, ...props }: any) {
          return <h2 className="text-base font-bold mt-3 mb-1 text-gray-900 border-b border-gray-200 pb-1" {...props}>{children}</h2>;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        h3({ children, ...props }: any) {
          return <h3 className="text-sm font-semibold mt-2 mb-0.5 text-gray-900" {...props}>{children}</h3>;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        h4({ children, ...props }: any) {
          return <h4 className="text-sm font-semibold text-gray-900" {...props}>{children}</h4>;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        h5({ children, ...props }: any) {
          return <h5 className="text-xs font-semibold text-gray-900" {...props}>{children}</h5>;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        h6({ children, ...props }: any) {
          return <h6 className="text-xs font-semibold text-gray-900" {...props}>{children}</h6>;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ul({ children, ...props }: any) {
          return <ul className="list-disc pl-5 my-1 space-y-0.5 text-sm text-gray-800" {...props}>{children}</ul>;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ol({ children, ...props }: any) {
          return <ol className="list-decimal pl-5 my-1 space-y-0.5 text-sm text-gray-800" {...props}>{children}</ol>;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        blockquote({ children, ...props }: any) {
          return (
            <blockquote
              className="border-l-4 border-blue-300 bg-blue-50 pl-3 py-0.5 my-1 text-gray-600 text-sm italic"
              {...props}
            >
              {children}
            </blockquote>
          );
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        table({ children, ...props }: any) {
          return (
            <div className="overflow-x-auto my-2">
              <table className="border-collapse text-sm text-gray-800 w-full" {...props}>
                {children}
              </table>
            </div>
          );
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        th({ children, ...props }: any) {
          return (
            <th className="border border-gray-300 bg-gray-100 px-2 py-1 text-left font-semibold text-xs" {...props}>
              {children}
            </th>
          );
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        td({ children, ...props }: any) {
          return (
            <td className="border border-gray-200 px-2 py-1 text-xs" {...props}>
              {children}
            </td>
          );
        },
        hr() {
          return <hr className="my-3 border-gray-200" />;
        },
      }}
    >
      {processedText}
    </ReactMarkdown>
  );
}

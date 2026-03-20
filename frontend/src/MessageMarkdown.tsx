import { useEffect, useId, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js";

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
}

export function MessageMarkdown({ text, streaming, onImageClick }: MessageMarkdownProps) {
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
      {text}
    </ReactMarkdown>
  );
}

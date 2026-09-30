import { InlineReference } from "@/components/ui/inline-reference";
import { createContext, memo, useContext, useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PathOpenContext, looksLikePath } from "@/features/chat/workspaceLink";
import { canOpenLocator, classifyMessageLink, LocatorOpenContext } from "@/features/chat/messageLinks";
import { remarkLocatorLinks } from "./remarkLocatorLinks";
import hljs from "highlight.js/lib/common";
import { cn } from "@/lib/cn";

interface Props {
  content: string;
  className?: string;
}

// Restrict auto-detection to the grammars actually seen in agent output. lib/common
// already ships ~37 languages; passing an explicit subset keeps highlightAuto's scan
// bounded and deterministic on the streaming hot path.
const AUTO_DETECT_LANGS = [
  "javascript", "typescript", "python", "rust", "json", "bash", "yaml",
  "xml", "css", "sql", "go", "java", "cpp", "markdown", "diff",
];

const InCodeBlock = createContext(false);

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function CodeBlock({
  language,
  children,
}: {
  language?: string;
  children: string;
}) {
  const highlighted = useMemo(() => {
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(children, { language }).value;
      }
      return hljs.highlightAuto(children, AUTO_DETECT_LANGS).value;
    } catch {
      return escapeHtml(children);
    }
  }, [language, children]);

  return (
    <pre className="rounded-sm bg-zinc-900 p-4 overflow-x-auto my-2">
      <code
        className={cn("hljs text-regular leading-reading", language && `language-${language}`)}
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </pre>
  );
}

function RenderCode({ className, children }: { className?: string; children?: ReactNode }) {
  const inCodeBlock = useContext(InCodeBlock);
  const onPath = useContext(PathOpenContext);
  const onLocator = useContext(LocatorOpenContext);
  const language = /language-(\w+)/.exec(className ?? "")?.[1];
  const value = String(children).replace(/\n$/, "");
  if (inCodeBlock) return <CodeBlock language={language}>{value}</CodeBlock>;
  if (onLocator && canOpenLocator(value)) {
    return <InlineReference reference={value} onClick={() => onLocator(value)} title={`Open ${value}`} aria-label={`Open ${value}`} />;
  }
  if (onPath && looksLikePath(value)) {
    return (
      <InlineReference
        reference={value}
        onClick={() => onPath(value)}
        title={`Open ${value} in the remote workspace`}
        aria-label={`Open ${value} in the remote workspace`}
      />
    );
  }
  return <code className="bg-zinc-800 px-1 py-1 rounded-sm text-regular">{children}</code>;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, className }: Props) {
  const onPath = useContext(PathOpenContext);
  const onLocator = useContext(LocatorOpenContext);
  // react-markdown v10 dropped the `className` prop (passing it throws). Wrap in a styled
  // div instead so "prose" + caller classes still apply.
  return (
    <div className={cn("prose", className)}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkLocatorLinks]}
      urlTransform={(url) => classifyMessageLink(url) ? url : ""}
      components={{
        pre({ children }) {
          return <InCodeBlock.Provider value>{children}</InCodeBlock.Provider>;
        },
        code({ className, children }) {
          return <RenderCode className={className}>{children}</RenderCode>;
        },
        a({ href, children }) {
          const target = href ? classifyMessageLink(href) : null;
          if (target?.kind === "external") {
            return <a href={target.href} target="_blank" rel="noopener noreferrer">{children}</a>;
          }
          if (target?.kind === "locator" && onLocator && canOpenLocator(target.uri)) {
            return <a href={`#workspace-ref-${encodeURIComponent(target.uri)}`} onClick={(event) => { event.preventDefault(); onLocator(target.uri); }} title={`Open ${target.uri}`}>{children}</a>;
          }
          if (target?.kind === "file" && onPath) {
            return <a href={`#workspace-ref-${encodeURIComponent(target.ref)}`} onClick={(event) => { event.preventDefault(); onPath(target.ref); }} title={`Open ${target.ref}`}>{children}</a>;
          }
          return <>{children}</>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
    </div>
  );
});

import { useContext, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PathOpenContext, looksLikePath } from "@/features/chat/workspaceLink";
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
      return children;
    }
  }, [language, children]);

  return (
    <pre className="rounded-lg bg-zinc-900 p-4 overflow-x-auto my-2">
      <code
        className={cn("hljs text-sm leading-relaxed", language && `language-${language}`)}
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </pre>
  );
}

export function MarkdownRenderer({ content, className }: Props) {
  const onPath = useContext(PathOpenContext);
  // react-markdown v10 dropped the `className` prop (passing it throws). Wrap in a styled
  // div instead so "prose" + caller classes still apply.
  return (
    <div className={cn("prose", className)}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre({ children }) {
          return <>{children}</>;
        },
        code({ className: cls, children }) {
          const language = /language-(\w+)/.exec(cls ?? "")?.[1];
          const text = String(children).replace(/\n$/, "");
          if (language || (cls && cls.includes("language-"))) {
            return <CodeBlock language={language}>{text}</CodeBlock>;
          }
          // Linkify a backtick-wrapped path to the remote-workspace browser.
          if (onPath && looksLikePath(text)) {
            return (
              <button
                type="button"
                onClick={() => onPath(text)}
                title="Open in the remote workspace"
                className="bg-zinc-800 px-1 py-0.5 rounded text-sm text-indigo-400 hover:text-indigo-300 hover:underline"
              >
                {children} ↗
              </button>
            );
          }
          return <code className="bg-zinc-800 px-1 py-0.5 rounded text-sm">{children}</code>;
        },
        a({ href, children }) {
          return (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
    </div>
  );
}

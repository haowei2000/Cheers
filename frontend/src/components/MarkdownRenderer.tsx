import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js";
import { cn } from "@/lib/cn";

interface Props {
  content: string;
  className?: string;
}

function CodeBlock({
  language,
  children,
}: {
  language?: string;
  children: string;
}) {
  let highlighted = children;
  try {
    if (language && hljs.getLanguage(language)) {
      highlighted = hljs.highlight(children, { language }).value;
    } else {
      highlighted = hljs.highlightAuto(children).value;
    }
  } catch {
    // leave as-is
  }

  return (
    <pre className="rounded-lg bg-zinc-900 border border-zinc-800 p-4 overflow-x-auto my-2">
      <code
        className={cn("hljs text-sm leading-relaxed", language && `language-${language}`)}
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </pre>
  );
}

export function MarkdownRenderer({ content, className }: Props) {
  return (
    <ReactMarkdown
      className={cn("prose", className)}
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
  );
}

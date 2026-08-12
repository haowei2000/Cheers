import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export const publicPanelClass =
  "bg-transparent p-0 space-y-4 [&_button]:!rounded-[2px] [&_button]:!border-0 [&_button]:!shadow-none [&_input]:!rounded-[2px]";

export const publicLabelClass =
  "font-utility text-compact font-semibold text-zinc-400 uppercase tracking-[0.1em]";

export const publicLinkClass =
  "font-utility text-zinc-200 underline decoration-zinc-700 underline-offset-4 hover:decoration-zinc-200";

interface PublicPageShellProps {
  title: string;
  description?: ReactNode;
  eyebrow?: string;
  children: ReactNode;
  width?: "form" | "wide";
}

/** Shared public/auth shell. It deliberately uses the same three type roles as
 * the website: serif masthead, serif reading copy, and sans-serif controls. */
export function PublicPageShell({
  title,
  description,
  eyebrow = "Cheers · Private edition",
  children,
  width = "form",
}: PublicPageShellProps) {
  return (
    <main className="public-edition h-full overflow-y-auto bg-zinc-950 text-zinc-100">
      <div className="mx-auto grid min-h-full w-full max-w-6xl gap-x-16 md:grid-cols-[minmax(260px,0.8fr)_minmax(380px,1.2fr)]">
        <aside className="hidden px-8 py-9 md:flex md:flex-col">
          <Link to="/" className="font-masthead text-comfortable tracking-[0.01em] text-zinc-100">
            Cheers
          </Link>
          <div className="mt-auto max-w-xs border-t border-zinc-800 pt-5">
            <p className="font-utility text-minimal font-semibold uppercase tracking-[0.14em] text-zinc-500">
              A shared desk for people and agents
            </p>
            <p className="font-reading mt-3 text-regular leading-6 text-zinc-400">
              Conversations, files, context, and accountable actions in one workspace.
            </p>
          </div>
        </aside>

        <section className="flex min-h-full items-center justify-center px-5 py-8 sm:px-8 md:px-12">
          <div className={width === "wide" ? "w-full max-w-xl" : "w-full max-w-md"}>
            <div className="mb-6 border-b border-zinc-800 pb-5">
              <div className="mb-8 flex items-center justify-between md:hidden">
                <Link to="/" className="font-masthead text-comfortable text-zinc-100">
                  Cheers
                </Link>
                <span className="font-utility text-minimal uppercase tracking-[0.12em] text-zinc-600">
                  Web edition
                </span>
              </div>
              <p className="font-utility text-minimal font-semibold uppercase tracking-[0.14em] text-zinc-500">
                {eyebrow}
              </p>
              <h1 className="font-masthead mt-2 text-comfortable font-normal leading-[0.98] tracking-[0.005em] text-zinc-50">
                {title}
              </h1>
              {description && (
                <p className="font-reading mt-3 max-w-[44ch] text-regular leading-6 text-zinc-400">
                  {description}
                </p>
              )}
            </div>
            {children}
          </div>
        </section>
      </div>
    </main>
  );
}

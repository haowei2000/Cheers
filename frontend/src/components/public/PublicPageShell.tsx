import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export const publicPanelClass =
  "bg-transparent p-0 space-y-4 [&_button]:!rounded-sm [&_button]:!border-0 [&_button]:!shadow-none [&_input]:!rounded-sm";

export const publicLabelClass =
  "font-utility text-compact font-semibold text-content-muted uppercase tracking-overline";

export const publicLinkClass =
  "font-utility text-content-secondary underline decoration-zinc-700 underline-offset-4 hover:decoration-zinc-200";

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
    <main className="public-edition h-full overflow-y-auto bg-zinc-950 text-content-primary">
      <div className="mx-auto grid min-h-full w-full max-w-6xl gap-x-16 md:grid-cols-[minmax(260px,0.8fr)_minmax(380px,1.2fr)]">
        <aside className="hidden px-8 py-9 md:flex md:flex-col">
          <Link to="/" className="font-masthead text-comfortable tracking-masthead text-content-primary">
            Cheers
          </Link>
          <div className="mt-auto max-w-xs border-t border-zinc-800 pt-5">
            <p className="font-utility text-minimal font-semibold uppercase tracking-overline text-content-muted">
              A shared desk for people and agents
            </p>
            <p className="font-reading mt-3 text-regular leading-6 text-content-muted">
              Conversations, files, context, and accountable actions in one workspace.
            </p>
          </div>
        </aside>

        <section className="flex min-h-full items-center justify-center px-5 py-8 sm:px-8 md:px-12">
          <div className={width === "wide" ? "w-full max-w-xl" : "w-full max-w-md"}>
            <div className="mb-6 border-b border-zinc-800 pb-5">
              <div className="mb-8 flex items-center justify-between md:hidden">
                <Link to="/" className="font-masthead text-comfortable text-content-primary">
                  Cheers
                </Link>
                <span className="font-utility text-minimal uppercase tracking-overline text-content-muted">
                  Web edition
                </span>
              </div>
              <p className="font-utility text-minimal font-semibold uppercase tracking-overline text-content-muted">
                {eyebrow}
              </p>
              <h1 className="font-masthead mt-2 text-comfortable font-normal leading-masthead tracking-masthead text-content-strong">
                {title}
              </h1>
              {description && (
                <p className="font-reading mt-3 max-w-[44ch] text-regular leading-6 text-content-muted">
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

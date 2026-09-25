import { forwardRef, type AnchorHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

interface SkipLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /** id of the region to jump to. That element needs tabIndex={-1} or focus
   *  never actually lands there — the browser scrolls but keeps focus behind. */
  targetId: string;
}

/**
 * The first focusable element on a page, invisible until it is tabbed to.
 * Without it every keyboard user walks the whole rail and sidebar before
 * reaching a letter. It costs nothing visually, which is exactly why it is the
 * thing that never gets built.
 */
export const SkipLink = forwardRef<HTMLAnchorElement, SkipLinkProps>(
  ({ targetId, className, children = "Skip to content", ...props }, ref) => (
    <a
      ref={ref}
      href={`#${targetId}`}
      className={cn(
        "sr-only",
        "focus-visible:not-sr-only focus-visible:fixed focus-visible:left-4 focus-visible:top-4 focus-visible:z-50",
        "focus-visible:flex focus-visible:items-center focus-visible:rounded-sm",
        "focus-visible:bg-content-strong focus-visible:px-3 focus-visible:py-2",
        "focus-visible:text-regular focus-visible:font-medium focus-visible:text-content-on-light",
        "focus-visible:shadow-xl focus-visible:shadow-black/40 focus-visible:outline-none",
        className
      )}
      {...props}
    >
      {children}
    </a>
  )
);
SkipLink.displayName = "SkipLink";

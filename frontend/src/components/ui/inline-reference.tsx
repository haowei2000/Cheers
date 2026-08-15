import { forwardRef, type AnchorHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export interface InlineReferenceProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /** The exact reference shown in prose. It must never be replaced by an action label. */
  reference: string;
}

/**
 * An interactive reference embedded in reading text. This is intentionally an
 * inline text affordance rather than a control-size Button: the reference is
 * the content, while the full action belongs to the accessible name.
 */
export const InlineReference = forwardRef<HTMLAnchorElement, InlineReferenceProps>(
  ({ reference, className, onClick, ...props }, ref) => (
    <a
      ref={ref}
      href={`#workspace-ref-${encodeURIComponent(reference)}`}
      data-inline-reference=""
      className={cn(
        "inline cursor-pointer rounded-sm bg-zinc-800 px-1 py-0 align-baseline font-code text-inherit text-accent-300 underline decoration-indigo-400/60 decoration-dotted underline-offset-2 transition-colors hover:bg-zinc-700 hover:text-accent-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
        className,
      )}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
      {...props}
    >
      {reference}
    </a>
  ),
);
InlineReference.displayName = "InlineReference";

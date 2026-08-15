import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { ContentSize } from "@/components/ui/content-size";

const sizeClasses: Record<ContentSize, string> = {
  small: "min-h-3.5 min-w-3.5 px-1 text-minimal",
  regular: "min-h-4 min-w-4 px-1 text-minimal",
  large: "min-h-5 min-w-5 px-2 text-compact",
};

const toneClasses = {
  unread: "bg-indigo-600 text-content-on-accent",
  mention: "bg-rose-600 text-content-on-accent",
  approval: "bg-amber-600 text-content-on-accent",
} as const;

/** Shared circular state counter. ContentSize changes the mark, never its owning hit target. */
export function UnreadBadge({
  children,
  contentSize = "regular",
  tone = "unread",
  className,
  ...props
}: Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  children: ReactNode;
  contentSize?: ContentSize;
  tone?: keyof typeof toneClasses;
}) {
  return (
    <span
      data-design-system-exempt="unread"
      className={cn(
        "inline-flex flex-shrink-0 items-center justify-center rounded-full font-bold tabular-nums leading-none",
        sizeClasses[contentSize],
        toneClasses[tone],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}

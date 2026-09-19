import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export type BadgeTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "mention";

const toneClasses: Record<BadgeTone, string> = {
  neutral: "bg-control text-content-muted",
  accent: "bg-selected text-content-strong",
  success: "bg-emerald-950/60 text-success-300",
  warning: "bg-amber-950/60 text-warning-300",
  danger: "bg-red-950/60 text-danger-300",
  info: "bg-sky-950/60 text-info-300",
  mention: "bg-rose-600 text-content-on-accent",
};

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  children: ReactNode;
  tone?: BadgeTone;
  /** Adds a same-color dot so status is never communicated by hue alone. */
  indicator?: boolean;
  disabled?: boolean;
}

/**
 * Compact, non-interactive status or identity label. Actions belong in Button;
 * counts and unread state continue to use the circular UnreadBadge primitive.
 */
export function Badge({
  children,
  tone = "neutral",
  indicator = false,
  disabled = false,
  className,
  ...props
}: BadgeProps) {
  return (
    <span
      data-badge-tone={tone}
      aria-disabled={disabled || undefined}
      className={cn(
        "inline-flex h-5 max-w-full flex-shrink-0 items-center gap-1 rounded-sm px-2 font-utility text-minimal font-medium leading-none tracking-label whitespace-nowrap",
        toneClasses[tone],
        disabled && "opacity-50",
        className,
      )}
      {...props}
    >
      {indicator && (
        <span
          aria-hidden="true"
          data-design-system-exempt="status-indicator"
          className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-current"
        />
      )}
      <span className="truncate">{children}</span>
    </span>
  );
}

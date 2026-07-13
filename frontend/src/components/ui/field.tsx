import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

// Form field stack (DESIGN.md §2.13): a persistent label over a control, with an
// optional hint. The label is never replaced by a placeholder (HIG data-entry
// floor). `children` is any shared field (Input/Textarea/Select) or a custom row.
export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="block text-xs font-medium uppercase tracking-wide text-zinc-400"
      >
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-zinc-400">{hint}</p>}
    </div>
  );
}

// A read-only metadata row for a card's "Details" section (DESIGN.md §2.13):
// a fixed-width label beside a value area. `children` is the value — a code
// pill + copy button, a plain span, or a small control (Issue token, a Select).
// Both identity cards use this so Bot ID / User ID / Role / Channels line up.
export function MetaRow({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3 text-xs", className)}>
      <span className="w-24 shrink-0 text-zinc-400">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
    </div>
  );
}

// In-card divider heading (DESIGN.md §2.13). Don't repeat a heading the
// surrounding chrome already states.
export function SectionHead({
  children,
  icon: Icon,
  className,
}: {
  children: ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400",
        className
      )}
    >
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {children}
    </p>
  );
}

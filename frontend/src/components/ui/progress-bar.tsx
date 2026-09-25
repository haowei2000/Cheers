import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type ProgressTone = "neutral" | "danger" | "success";

interface ProgressBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "role"> {
  /** 0-100. Omit for an indeterminate bar, for work with no known end. */
  value?: number;
  /** Accessible name — what is progressing, not just "progress". Required,
   *  because a bar with no name tells a screen reader nothing at all. */
  label: string;
  tone?: ProgressTone;
}

const toneClasses: Record<ProgressTone, string> = {
  neutral: "bg-content-strong",
  danger: "bg-danger-400",
  success: "bg-success-400",
};

/**
 * A continuously updating bar for a long-running task. For a flow made of
 * discrete named steps, that is a step indicator, not this.
 *
 * The track is 6px tall and takes the shared 10px radius, which clamps to half
 * the height — a pill, without an unregistered rounded-full.
 */
export const ProgressBar = forwardRef<HTMLDivElement, ProgressBarProps>(
  ({ value, label, tone = "neutral", className, ...props }, ref) => {
    const indeterminate = value === undefined;
    const clamped = indeterminate ? 0 : Math.min(100, Math.max(0, value));
    return (
      <div
        ref={ref}
        role="progressbar"
        aria-label={label}
        aria-valuenow={indeterminate ? undefined : Math.round(clamped)}
        aria-valuemin={indeterminate ? undefined : 0}
        aria-valuemax={indeterminate ? undefined : 100}
        className={cn("h-1.5 w-full overflow-hidden rounded-sm bg-control", className)}
        {...props}
      >
        <div
          className={cn(
            "h-full rounded-sm transition-all duration-100",
            toneClasses[tone],
            indeterminate && "w-2/5 animate-pulse"
          )}
          style={indeterminate ? undefined : { width: `${clamped}%` }}
        />
      </div>
    );
  }
);
ProgressBar.displayName = "ProgressBar";

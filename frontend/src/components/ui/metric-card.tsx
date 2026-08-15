import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type MetricTone = "neutral" | "accent" | "warning" | "danger" | "success";

const valueToneClasses: Record<MetricTone, string> = {
  neutral: "text-content-primary",
  accent: "text-accent-200",
  warning: "text-warning-300",
  danger: "text-danger-300",
  success: "text-success-300",
};

export function MetricCard({
  label,
  value,
  tone = "neutral",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: MetricTone;
  className?: string;
}) {
  return (
    <div className={cn("rounded-sm bg-panel px-4 py-3", className)}>
      <p className="text-section-label">{label}</p>
      <p className={cn("mt-1 text-comfortable font-semibold tabular-nums", valueToneClasses[tone])}>
        {value}
      </p>
    </div>
  );
}

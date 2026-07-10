import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

// The canonical loading indicator (DESIGN.md §2.10). Color inherits
// currentColor — set a text-* class on it (or a parent) to tint it.
export function Spinner({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return <Loader2 size={size} className={cn("animate-spin", className)} />;
}

// Full-surface variant: centered, muted — for panel/page loads.
export function SurfaceSpinner({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center justify-center py-8", className)}>
      <Spinner size={20} className="text-zinc-600" />
    </div>
  );
}

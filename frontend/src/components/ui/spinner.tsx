import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { contentIconClasses, type ContentSize } from "./content-size";

// The canonical loading indicator (DESIGN.md §2.10). Color inherits
// currentColor — set a text-* class on it (or a parent) to tint it.
export function Spinner({
  contentSize = "regular",
  className,
}: {
  contentSize?: ContentSize;
  className?: string;
}) {
  return <Loader2 className={cn("animate-spin", contentIconClasses[contentSize], className)} />;
}

// Full-surface variant: centered, muted — for panel/page loads.
export function SurfaceSpinner({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center justify-center py-8", className)}>
      <Spinner contentSize="large" className="text-zinc-600" />
    </div>
  );
}

import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type SkeletonShape = "text" | "block" | "circle";

interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  shape?: SkeletonShape;
  /** Number of stacked lines. Only meaningful for shape="text". */
  lines?: number;
}

// A skeleton stands in for a specific shape, so it borrows that shape's radius
// rather than inventing one. On a square, the shared 10px radius clamps to half
// the side, which is how "circle" gets a circle without an unregistered radius.
const shapeClasses: Record<SkeletonShape, string> = {
  text: "h-3 rounded-sm",
  block: "h-24 w-full rounded-sm",
  circle: "h-9 w-9 rounded-sm",
};

/**
 * Placeholder for content that has not arrived. The whole block is hidden from
 * assistive technology — one polite status message elsewhere says "loading",
 * rather than a screen reader reading out a dozen grey rectangles.
 */
export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(
  ({ shape = "text", lines = 1, className, ...props }, ref) => {
    if (shape === "text" && lines > 1) {
      return (
        <div ref={ref} aria-hidden className={cn("flex flex-col gap-2", className)} {...props}>
          {Array.from({ length: lines }, (_, i) => (
            <div
              key={i}
              className={cn(
                "animate-pulse bg-control",
                shapeClasses.text,
                // The last line runs short, the way a paragraph actually ends.
                i === lines - 1 ? "w-3/5" : "w-full"
              )}
            />
          ))}
        </div>
      );
    }
    return (
      <div
        ref={ref}
        aria-hidden
        className={cn("animate-pulse bg-control", shapeClasses[shape], shape === "text" && "w-full", className)}
        {...props}
      />
    );
  }
);
Skeleton.displayName = "Skeleton";

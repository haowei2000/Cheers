import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { dragHandleClasses } from "@/components/ui/content-size";

export function DragHandle({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-design-system-exempt="drag-handle"
      className={cn(dragHandleClasses, "bg-zinc-700", className)}
      aria-hidden
      {...props}
    />
  );
}


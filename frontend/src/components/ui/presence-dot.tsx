import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import {
  presenceSizeClasses,
  type ContentSize,
} from "@/components/ui/content-size";

export interface PresenceDotProps extends HTMLAttributes<HTMLSpanElement> {
  contentSize?: ContentSize;
}

/** Shared state dot. Colour remains semantic; diameter comes only from ContentSize. */
export function PresenceDot({
  contentSize = "regular",
  className,
  ...props
}: PresenceDotProps) {
  return (
    <span
      data-content-size={contentSize}
      data-design-system-exempt="presence"
      className={cn(
        "inline-block flex-shrink-0 rounded-full",
        presenceSizeClasses[contentSize],
        className
      )}
      {...props}
    />
  );
}


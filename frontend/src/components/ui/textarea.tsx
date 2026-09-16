import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { controlMinHeightClasses, useControlSize, type ControlSize } from "./control-size";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
  controlSize?: ControlSize;
}

// Filled textarea with the same accessible inset boundary as Input (DESIGN.md §2.3).
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ error, controlSize, className, ...props }, ref) => {
    const size = useControlSize(controlSize);
    return (
    <textarea
      ref={ref}
      className={cn(
        "w-full rounded-sm bg-control/60 px-3 py-2 text-comfortable md:text-regular text-content-primary placeholder:text-content-muted ring-1 ring-inset ring-zinc-700/60 transition-shadow",
        controlMinHeightClasses[size],
        "focus:outline-none focus:ring-1 focus:ring-content-strong/50",
        error && "ring-1 ring-red-500/70",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className
      )}
      {...props}
    />
    );
  }
);
Textarea.displayName = "Textarea";

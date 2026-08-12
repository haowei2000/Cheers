import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { controlMinHeightClasses, useControlSize, type ControlSize } from "./control-size";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
  controlSize?: ControlSize;
}

// Borderless filled textarea mirroring Input (DESIGN.md §2.3).
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ error, controlSize, className, ...props }, ref) => {
    const size = useControlSize(controlSize);
    return (
    <textarea
      ref={ref}
      className={cn(
        "w-full rounded-sm bg-zinc-800 px-3 py-2 text-comfortable md:text-regular text-zinc-100 placeholder-zinc-500 transition-shadow",
        controlMinHeightClasses[size],
        "focus:outline-none focus:ring-2 focus:ring-indigo-500",
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

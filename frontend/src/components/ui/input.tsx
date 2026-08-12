import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { controlHeightClasses, useControlSize, type ControlSize } from "./control-size";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
  controlSize?: ControlSize;
  inset?: "default" | "leading";
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ error, controlSize, inset = "default", className, ...props }, ref) => {
    const size = useControlSize(controlSize);
    return (
    <input
      ref={ref}
      className={cn(
        // Borderless filled field (DESIGN.md §2.3): the fill is the affordance,
        // Rings are states (neutral focus, semantic error red).
        // text-comfortable (16px) below md prevents iOS Safari's auto-zoom on focus.
        "w-full rounded-sm px-3 bg-zinc-800 text-zinc-100 placeholder-zinc-400 transition-shadow",
        inset === "leading" && "pl-9",
        controlHeightClasses[size],
        "text-comfortable md:text-regular",
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
Input.displayName = "Input";

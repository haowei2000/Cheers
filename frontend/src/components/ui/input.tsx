import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { controlHeightClasses, useControlSize, type ControlSize } from "./control-size";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
  controlSize?: ControlSize;
  variant?: "default" | "plain";
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ error, controlSize, variant = "default", className, ...props }, ref) => {
    const size = useControlSize(controlSize);
    return (
    <input
      ref={ref}
      className={cn(
        "w-full text-content-primary placeholder:text-content-muted transition-shadow",
        variant === "plain"
          ? "bg-transparent ring-0 border-0 rounded-none px-2 focus:bg-control/40 focus:ring-1 focus:ring-content-strong/40"
          : "rounded-sm px-3 bg-control/60 ring-1 ring-inset ring-zinc-700/60 focus:ring-1 focus:ring-content-strong/50",
        controlHeightClasses[size],
        "text-comfortable md:text-regular",
        "focus:outline-none",
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

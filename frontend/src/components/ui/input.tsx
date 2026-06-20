import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ error, className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-9 w-full rounded-lg border px-3 text-sm bg-zinc-800 text-zinc-100 placeholder-zinc-500 transition-colors duration-100",
        "focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent",
        error
          ? "border-red-500"
          : "border-zinc-700 hover:border-zinc-600",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";

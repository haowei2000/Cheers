import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import {
  controlHeightClasses,
  controlSquareClasses,
  controlTextClasses,
  useControlSize,
  type ControlSize,
} from "./control-size";

type Variant = "primary" | "ghost" | "danger" | "secondary";
type LegacySize = "sm" | "md" | "icon";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /** @deprecated Prefer controlSize; retained while existing call sites migrate. */
  size?: LegacySize;
  controlSize?: ControlSize;
  square?: boolean;
  loading?: boolean;
}

const variantCls: Record<Variant, string> = {
  primary:
    "bg-indigo-100 text-zinc-950 hover:bg-white active:bg-indigo-300",
  ghost:
    "bg-transparent text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 active:bg-zinc-700",
  danger:
    "bg-transparent text-red-400 hover:bg-red-950 hover:text-red-300 active:bg-red-900",
  secondary:
    "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 active:bg-zinc-600",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size,
      controlSize,
      square = size === "icon",
      loading,
      disabled,
      className,
      children,
      ...props
    },
    ref
  ) => {
    const inheritedSize = useControlSize(controlSize);
    const resolvedSize = size === "sm" ? "compact" : size === "md" || size === "icon" ? "regular" : inheritedSize;
    return <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:pointer-events-none disabled:opacity-50 select-none cursor-pointer",
        variantCls[variant],
        square ? controlSquareClasses[resolvedSize] : controlHeightClasses[resolvedSize],
        controlTextClasses[resolvedSize],
        square ? "rounded-sm p-0" : "rounded-sm px-3",
        className
      )}
      {...props}
    >
      {loading ? (
        <svg
          className="animate-spin h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8v8H4z"
          />
        </svg>
      ) : (
        children
      )}
    </button>;
  }
);
Button.displayName = "Button";

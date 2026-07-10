import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "ghost" | "danger" | "secondary";
type Size = "sm" | "md" | "icon";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const variantCls: Record<Variant, string> = {
  primary:
    "bg-indigo-600 text-white hover:bg-indigo-500 active:bg-indigo-700 shadow-sm",
  ghost:
    "bg-transparent text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 active:bg-zinc-700",
  danger:
    "bg-transparent text-red-400 hover:bg-red-950 hover:text-red-300 active:bg-red-900",
  secondary:
    "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 active:bg-zinc-600",
};

const sizeCls: Record<Size, string> = {
  sm: "h-7 px-3 text-xs rounded-md",
  md: "h-9 px-4 text-sm rounded-lg",
  icon: "h-8 w-8 rounded-lg flex items-center justify-center p-0",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      loading,
      disabled,
      className,
      children,
      ...props
    },
    ref
  ) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:pointer-events-none disabled:opacity-50 select-none cursor-pointer",
        variantCls[variant],
        sizeCls[size],
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
    </button>
  )
);
Button.displayName = "Button";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { controlSquareClasses, useControlSize, type ControlSize } from "./control-size";

type IconButtonTone = "neutral" | "danger" | "success" | "accent";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  tone?: IconButtonTone;
  controlSize?: ControlSize;
}

const toneClasses: Record<IconButtonTone, string> = {
  neutral: "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100",
  danger: "text-zinc-500 hover:bg-red-950/60 hover:text-red-400",
  success: "text-emerald-400 hover:bg-emerald-500/10",
  accent: "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      label,
      tone = "neutral",
      controlSize,
      className,
      children,
      type = "button",
      ...props
    },
    ref
  ) => {
    const size = useControlSize(controlSize);
    return (
      <button
        ref={ref}
        type={type}
        title={props.title ?? label}
        aria-label={label}
        data-control-size={size}
        className={cn(
          "inline-flex flex-shrink-0 items-center justify-center rounded-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:pointer-events-none disabled:opacity-50",
          controlSquareClasses[size],
          toneClasses[tone],
          className
        )}
        {...props}
      >
        {children}
      </button>
    );
  }
);
IconButton.displayName = "IconButton";

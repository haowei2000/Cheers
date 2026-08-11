import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import {
  usePresentationLevel,
  type PresentationLevel,
} from "@/components/ui/presentation";

type IconButtonTone = "neutral" | "danger" | "success" | "accent";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  tone?: IconButtonTone;
  presentationLevel?: PresentationLevel;
}

const toneClasses: Record<IconButtonTone, string> = {
  neutral: "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100",
  danger: "text-zinc-500 hover:bg-red-950/60 hover:text-red-400",
  success: "text-emerald-400 hover:bg-emerald-500/10",
  accent: "text-indigo-300 hover:bg-indigo-600/15 hover:text-indigo-200",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      label,
      tone = "neutral",
      presentationLevel,
      className,
      children,
      type = "button",
      ...props
    },
    ref
  ) => {
    const level = usePresentationLevel(presentationLevel);
    return (
      <button
        ref={ref}
        type={type}
        title={props.title ?? label}
        aria-label={label}
        data-presentation-level={level}
        className={cn(
          "inline-flex flex-shrink-0 items-center justify-center rounded-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:pointer-events-none disabled:opacity-50",
          level === "max" ? "h-10 w-10" : level === "medium" ? "h-9 w-9" : "h-8 w-8",
          "max-md:h-11 max-md:w-11",
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

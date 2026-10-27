import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import type { ControlSize } from "./control-size";
import { Button } from "./button";

type IconButtonTone = "neutral" | "danger" | "success" | "accent";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "content"> {
  label: string;
  tone?: IconButtonTone;
  controlSize?: ControlSize;
  /** Toggle state; the shared selected styling replaces the tone's resting colours. */
  selected?: boolean;
}

const toneClasses: Record<IconButtonTone, string> = {
  neutral: "text-content-primary hover:bg-control-hover hover:text-content-strong active:bg-control-active active:scale-[0.96] transition-all duration-100",
  danger: "text-content-primary hover:bg-red-950/60 hover:text-danger-400 active:bg-red-900/60 active:scale-[0.96] transition-all duration-100",
  success: "text-success-400 hover:bg-emerald-500/10 active:scale-[0.96] transition-all duration-100",
  accent: "text-content-primary hover:bg-control-hover hover:text-content-strong active:bg-control-active active:scale-[0.96] transition-all duration-100",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      label,
      tone = "neutral",
      controlSize,
      selected = false,
      className,
      children,
      type = "button",
      ...props
    },
    ref
  ) => {
    return (
      <Button
        ref={ref}
        type={type}
        title={props.title ?? label}
        aria-label={label}
        content="icon"
        controlSize={controlSize}
        variant="plain"
        selected={selected}
        className={cn(
          "shrink-0",
          !selected && toneClasses[tone],
          className
        )}
        {...props}
      >
        {children}
      </Button>
    );
  }
);
IconButton.displayName = "IconButton";

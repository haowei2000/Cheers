import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import type { ControlSize } from "./control-size";
import { Button } from "./button";

type IconButtonTone = "neutral" | "danger" | "success" | "accent";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "content"> {
  label: string;
  tone?: IconButtonTone;
  controlSize?: ControlSize;
}

const toneClasses: Record<IconButtonTone, string> = {
  neutral: "text-zinc-100 hover:bg-zinc-800 hover:text-zinc-50",
  danger: "text-zinc-100 hover:bg-red-950/60 hover:text-red-400",
  success: "text-emerald-400 hover:bg-emerald-500/10",
  accent: "text-zinc-100 hover:bg-zinc-800 hover:text-zinc-50",
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
    return (
      <Button
        ref={ref}
        type={type}
        title={props.title ?? label}
        aria-label={label}
        content="icon"
        controlSize={controlSize}
        variant="plain"
        className={cn(
          "flex-shrink-0",
          toneClasses[tone],
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

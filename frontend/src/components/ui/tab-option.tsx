import { forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button, type ButtonProps } from "./button";
import type { ControlSize } from "./control-size";

interface TabOptionProps
  extends Omit<ButtonProps, "aria-selected" | "children" | "content" | "controlSize" | "role" | "selected"> {
  label: ReactNode;
  leading?: ReactNode;
  selected: boolean;
  controlSize?: ControlSize;
}

/** A semantic tab using the shared selected-control surface. */
export const TabOption = forwardRef<HTMLButtonElement, TabOptionProps>(
  ({ label, leading, selected, controlSize, className, type = "button", ...props }, ref) => {
    return (
      <Button
        ref={ref}
        type={type}
        variant="plain"
        content="text"
        controlWidth="content"
        controlSize={controlSize}
        role="tab"
        aria-selected={selected}
        selected={selected}
        className={cn(
          "gap-2 rounded-sm px-2 text-content-primary transition-colors duration-150 hover:text-content-strong focus-visible:ring-inset",
          className
        )}
        {...props}
      >
        {leading}
        <span className="truncate">{label}</span>
      </Button>
    );
  }
);
TabOption.displayName = "TabOption";

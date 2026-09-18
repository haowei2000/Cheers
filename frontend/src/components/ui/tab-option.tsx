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

/** A semantic tab using an editorial underline instead of a bordered pill. */
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
          "gap-2 rounded-none border-b-2 bg-transparent ring-0 shadow-none px-2 transition-colors duration-150 hover:bg-transparent focus-visible:ring-inset",
          selected
            ? "border-content-strong text-content-strong font-semibold"
            : "border-transparent text-content-primary hover:text-content-strong",
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

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import {
  controlMinHeightClasses,
  controlTextClasses,
  useControlSize,
  type ControlSize,
} from "./control-size";

interface TabOptionProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: ReactNode;
  leading?: ReactNode;
  selected: boolean;
  controlSize?: ControlSize;
}

/** A semantic tab using an editorial underline instead of a bordered pill. */
export const TabOption = forwardRef<HTMLButtonElement, TabOptionProps>(
  ({ label, leading, selected, controlSize, className, type = "button", ...props }, ref) => {
    const size = useControlSize(controlSize);
    return (
      <button
        ref={ref}
        type={type}
        role="tab"
        aria-selected={selected}
        data-control-size={size}
        className={cn(
          "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-sm border-b-2 px-2 font-utility transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 disabled:pointer-events-none disabled:opacity-50",
          controlMinHeightClasses[size],
          controlTextClasses[size],
          selected
            ? "border-zinc-100 text-zinc-100"
            : "border-transparent text-zinc-400 hover:text-zinc-100",
          className
        )}
        {...props}
      >
        {leading}
        <span className="truncate">{label}</span>
      </button>
    );
  }
);
TabOption.displayName = "TabOption";

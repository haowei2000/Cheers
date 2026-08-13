import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import {
  controlMinHeightClasses,
  controlTextClasses,
  useControlSize,
  type ControlSize,
} from "./control-size";

interface MenuOptionProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  controlSize?: ControlSize;
}

/** A borderless menu/list action with the shared physical control rhythm. */
export const MenuOption = forwardRef<HTMLButtonElement, MenuOptionProps>(
  (
    {
      label,
      leading,
      trailing,
      selected = false,
      controlSize,
      className,
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
        role="menuitem"
        data-control-size={size}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left font-utility transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 disabled:pointer-events-none disabled:opacity-50",
          controlMinHeightClasses[size],
          controlTextClasses[size],
          selected
            ? "bg-zinc-800 text-zinc-100"
            : "text-zinc-100 hover:bg-zinc-800/70 hover:text-zinc-50",
          className
        )}
        {...props}
      >
        {leading && <span className="flex flex-shrink-0 items-center">{leading}</span>}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {trailing && <span className="ml-auto flex flex-shrink-0 items-center">{trailing}</span>}
      </button>
    );
  }
);
MenuOption.displayName = "MenuOption";

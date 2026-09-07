import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { ControlSizeProvider, type ControlSize } from "./control-size";

/** Layout boundary for actions, choices and switches. Children keep their own
 * semantics; the group owns spacing, wrapping and the optional floating surface. */
export const ButtonGroup = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & {
  label: string;
  controlSize?: ControlSize;
  floating?: boolean;
}>(({ label, controlSize = "compact", floating = false, className, children, role = "group", ...props }, ref) => (
  <ControlSizeProvider size={controlSize}>
    <div
      {...props}
      ref={ref}
      role={role}
      aria-label={label}
      data-button-group=""
      className={cn(
        "flex max-w-full flex-wrap items-center gap-1 [&>*]:shrink-0",
        floating && "floating-control-surface rounded-concentric p-1",
        className,
      )}
    >
      {children}
    </div>
  </ControlSizeProvider>
));
ButtonGroup.displayName = "ButtonGroup";

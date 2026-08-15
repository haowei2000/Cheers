import {
  cloneElement,
  forwardRef,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { Input, type InputProps } from "./input";
import {
  controlIconClasses,
  controlSquareClasses,
  useControlSize,
} from "./control-size";
import { cn } from "@/lib/cn";

export interface InputWithLeadingIconProps extends InputProps {
  leading: ReactNode;
  /** Layout belongs to the composite; visual input styles still use className. */
  containerClassName?: string;
}

/**
 * A shared single-line field whose decorative leading icon sits inside the
 * Input boundary. Input remains the sole owner of fill, radius, and focus ring.
 */
export const InputWithLeadingIcon = forwardRef<
  HTMLInputElement,
  InputWithLeadingIconProps
>(({ leading, controlSize, containerClassName, className, ...props }, ref) => {
  const size = useControlSize(controlSize);
  const sizedLeading = isValidElement(leading)
    ? cloneElement(leading as ReactElement<{ className?: string }>, {
        className: cn(
          (leading as ReactElement<{ className?: string }>).props.className,
          controlIconClasses[size],
        ),
      })
    : leading;

  return (
    <div
      data-input-composite="leading-icon"
      className={cn("relative min-w-0 w-full", containerClassName)}
    >
      <span
        data-input-slot="leading"
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-0 top-1/2 z-10 inline-flex -translate-y-1/2 items-center justify-center text-content-muted",
          controlSquareClasses[size],
        )}
      >
        {sizedLeading}
      </span>
      <Input
        {...props}
        ref={ref}
        controlSize={size}
        className={cn("pl-9", className)}
      />
    </div>
  );
});
InputWithLeadingIcon.displayName = "InputWithLeadingIcon";

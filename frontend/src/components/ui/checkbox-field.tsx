import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import {
  controlMinHeightClasses,
  useControlSize,
  type ControlSize,
} from "./control-size";
import { contentIconClasses } from "./content-size";

interface CheckboxFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  controlSize?: ControlSize;
}

/** Native checkbox semantics with one shared label/hit target. */
export const CheckboxField = forwardRef<HTMLInputElement, CheckboxFieldProps>(
  ({ label, hint, error, controlSize, className, id, ...props }, ref) => {
    const size = useControlSize(controlSize);
    return (
      <label
        htmlFor={id}
        className={cn(
          "flex min-w-0 items-start gap-2 rounded-sm px-1 font-utility text-regular text-zinc-300",
          controlMinHeightClasses[size],
          "max-md:items-center",
          props.disabled && "cursor-not-allowed opacity-50",
          className
        )}
      >
        {/* design-system-native: checkbox — preserve native form and accessibility semantics. */}
        <input
          {...props}
          ref={ref}
          id={id}
          type="checkbox"
          className={cn("mt-1 flex-shrink-0 accent-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 max-md:mt-0", contentIconClasses.regular)}
        />
        <span className="min-w-0 py-2 max-md:py-0">
          <span className="block">{label}</span>
          {hint && <span className="mt-1 block text-compact text-zinc-500">{hint}</span>}
          {error && <span className="mt-1 block text-compact text-red-400" role="alert">{error}</span>}
        </span>
      </label>
    );
  }
);
CheckboxField.displayName = "CheckboxField";

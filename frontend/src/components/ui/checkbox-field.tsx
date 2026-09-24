import { Check, Minus } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
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
  indeterminate?: boolean;
}

/** Native checkbox semantics with the kit's shared visual states and one label/hit target. */
export const CheckboxField = forwardRef<HTMLInputElement, CheckboxFieldProps>(
  ({ label, hint, error, controlSize, className, id, indeterminate = false, ...props }, ref) => {
    const size = useControlSize(controlSize);
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
      if (inputRef.current) inputRef.current.indeterminate = indeterminate;
    }, [indeterminate]);

    return (
      <label
        htmlFor={inputId}
        className={cn(
          "flex min-w-0 items-start gap-2 rounded-sm text-body-secondary",
          controlMinHeightClasses[size],
          "max-md:items-center",
          props.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
          className
        )}
      >
        {/* design-system-native: checkbox — native semantics stay intact behind the shared visual. */}
        <input
          {...props}
          ref={(node) => {
            inputRef.current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
          }}
          id={inputId}
          type="checkbox"
          aria-invalid={error ? true : props["aria-invalid"]}
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className={cn(
            "mt-1 grid flex-shrink-0 place-items-center rounded-[3px] bg-control text-content-on-light ring-1 ring-inset ring-zinc-600 transition-colors duration-100",
            contentIconClasses.regular,
            "peer-checked:bg-content-strong peer-checked:ring-0",
            "peer-focus-visible:ring-2 peer-focus-visible:ring-content-strong/60",
            "peer-aria-invalid:ring-danger-400",
            "[&_[data-check]]:opacity-0 [&_[data-mixed]]:opacity-0",
            "peer-checked:[&_[data-check]]:opacity-100",
            "peer-[:indeterminate]:bg-content-strong peer-[:indeterminate]:ring-0",
            "peer-[:indeterminate]:[&_[data-check]]:opacity-0 peer-[:indeterminate]:[&_[data-mixed]]:opacity-100",
            "max-md:mt-0"
          )}
        >
          <Check data-check className="col-start-1 row-start-1 h-3.5 w-3.5 stroke-[2.5]" />
          <Minus data-mixed className="col-start-1 row-start-1 h-3.5 w-3.5 stroke-[2.5]" />
        </span>
        <span className="min-w-0 py-2 max-md:py-0">
          <span className="block">{label}</span>
          {hint && <span className="mt-1 block text-caption">{hint}</span>}
          {error && <span className="mt-1 block text-caption-error" role="alert">{error}</span>}
        </span>
      </label>
    );
  }
);
CheckboxField.displayName = "CheckboxField";

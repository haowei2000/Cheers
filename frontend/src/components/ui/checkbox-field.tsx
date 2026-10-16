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
import { HelpLabel } from "./help-text";

interface CheckboxFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> {
  label: ReactNode;
  tip?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  controlSize?: ControlSize;
  indeterminate?: boolean;
}

/** Native checkbox semantics with the kit's shared visual states and one label/hit target. */
export const CheckboxField = forwardRef<HTMLInputElement, CheckboxFieldProps>(
  ({ label, tip, hint, error, controlSize, className, id, indeterminate = false, ...props }, ref) => {
    const size = useControlSize(controlSize);
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const inputRef = useRef<HTMLInputElement | null>(null);
    const errorId = `${inputId}-error`;

    useEffect(() => {
      if (inputRef.current) inputRef.current.indeterminate = indeterminate;
    }, [indeterminate]);

    return (
      <div
        className={cn(
          "min-w-0 space-y-1 rounded-sm text-body-secondary",
          props.disabled && "opacity-50",
          className
        )}
      >
        <label htmlFor={inputId} className={cn("flex min-w-0 items-center gap-2", controlMinHeightClasses[size], props.disabled ? "cursor-not-allowed" : "cursor-pointer")}>
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
            aria-describedby={[props["aria-describedby"], error ? errorId : undefined].filter(Boolean).join(" ") || undefined}
            className="peer sr-only"
          />
          <span
            aria-hidden="true"
            className={cn(
              "grid shrink-0 place-items-center rounded-[3px] bg-control text-content-on-light ring-1 ring-inset ring-zinc-600 transition-colors duration-100",
              contentIconClasses.regular,
              "peer-checked:bg-content-strong peer-checked:ring-0",
              "peer-focus-visible:ring-2 peer-focus-visible:ring-content-strong/60",
              "peer-aria-invalid:ring-danger-400",
              "**:data-check:opacity-0 **:data-mixed:opacity-0",
              "peer-checked:**:data-check:opacity-100",
              "peer-indeterminate:bg-content-strong peer-indeterminate:ring-0",
              "peer-indeterminate:**:data-check:opacity-0 peer-indeterminate:**:data-mixed:opacity-100"
            )}
          >
            <Check data-check className="col-start-1 row-start-1 h-3.5 w-3.5 stroke-[2.5]" />
            <Minus data-mixed className="col-start-1 row-start-1 h-3.5 w-3.5 stroke-[2.5]" />
          </span>
          <span className="min-w-0 flex-1">
            <HelpLabel help={tip && hint ? <>{tip}<br />{hint}</> : tip ?? hint}>{label}</HelpLabel>
          </span>
        </label>
        {error && <p id={errorId} className="ml-6 text-caption-error" role="alert">{error}</p>}
      </div>
    );
  }
);
CheckboxField.displayName = "CheckboxField";

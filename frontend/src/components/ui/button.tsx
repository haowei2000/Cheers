import { Children, forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { actionLabel, type ActionKey } from "./action-labels";
import {
  controlHeightClasses,
  controlSquareClasses,
  controlTextClasses,
  useControlSize,
  type ControlSize,
} from "./control-size";

type Variant = "primary" | "ghost" | "danger" | "secondary" | "plain";
export type ControlWidth = "slot" | "fill";
export type ButtonContent = "icon" | "text" | "iconText";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "content"> {
  variant?: Variant;
  controlSize?: ControlSize;
  /** Text controls use a registered width slot; containers may explicitly request fill. */
  controlWidth?: ControlWidth;
  /** Icon is content="icon"; text uses the 96px slot; iconText uses the 128px slot. */
  content?: ButtonContent;
  /** Generates the visible short label from the shared action dictionary. */
  action?: ActionKey;
  loading?: boolean;
}

const variantCls: Record<Variant, string> = {
  primary:
    "bg-indigo-100 text-zinc-950 hover:bg-white active:bg-indigo-300",
  ghost:
    "bg-transparent text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 active:bg-zinc-700",
  danger:
    "bg-transparent text-red-400 hover:bg-red-950 hover:text-red-300 active:bg-red-900",
  secondary:
    "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 active:bg-zinc-600",
  plain:
    "bg-transparent text-inherit hover:bg-zinc-800/70 active:bg-zinc-700/70",
};

function LoadingIndicator() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v8H4z"
      />
    </svg>
  );
}

function IconTextContent({ action, children, loading, size }: {
  action?: ActionKey;
  children: ReactNode;
  loading?: boolean;
  size: ControlSize;
}) {
  const parts = Children.toArray(children);
  const leading = parts.shift();
  return (
    <>
      <span
        data-button-slot="icon"
        aria-hidden="true"
        className={cn(
          "inline-flex flex-shrink-0 items-center justify-center self-stretch bg-black/10 [&>svg]:flex-shrink-0",
          controlSquareClasses[size],
        )}
      >
        {loading ? <LoadingIndicator /> : leading}
      </span>
      <span
        data-button-slot="label"
        className="inline-flex min-w-0 flex-1 items-center justify-center self-stretch px-3"
      >
        {action ? actionLabel(action) : parts}
      </span>
    </>
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      controlSize,
      controlWidth = "slot",
      content = "text",
      action,
      loading,
      disabled,
      className,
      children,
      ...props
    },
    ref
  ) => {
    const inheritedSize = useControlSize(controlSize);
    const resolvedSize = inheritedSize;
    return <button
      ref={ref}
      disabled={disabled || loading}
      data-control-size={resolvedSize}
      data-button-content={content}
      data-control-width={controlWidth}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex min-w-0 items-center justify-center font-utility font-medium whitespace-nowrap transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:pointer-events-none disabled:opacity-50 select-none cursor-pointer [&>svg]:flex-shrink-0",
        variantCls[variant],
        className,
        content === "icon" ? controlSquareClasses[resolvedSize] : controlHeightClasses[resolvedSize],
        controlTextClasses.regular,
        content === "icon"
          ? "rounded-sm p-0"
          : cn(
              "rounded-sm",
              content === "text" ? "gap-2 px-3" : "gap-0 p-0",
              controlWidth === "fill" ? "w-full" : content === "iconText" ? "w-32 max-w-full" : "w-24 max-w-full",
            ),
      )}
      {...props}
    >
      {content === "iconText" ? (
        <IconTextContent action={action} loading={loading} size={resolvedSize}>{children}</IconTextContent>
      ) : content === "icon" ? (
        loading ? <LoadingIndicator /> : children
      ) : (
        <>{loading && <LoadingIndicator />}{action ? actionLabel(action) : children}</>
      )}
    </button>;
  }
);
Button.displayName = "Button";

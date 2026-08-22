import { Children, forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { actionLabel, isFillActionKey, type ActionKey } from "./action-labels";
import {
  controlHeightClasses,
  controlSquareClasses,
  controlTextClasses,
  useControlSize,
  type ControlSize,
} from "./control-size";

// Vite injects import.meta.env; the repo casts rather than pulling in vite/client
// types (same shape as lib/serverConfig.ts).
const DEV = (import.meta as { env?: { DEV?: boolean } }).env?.DEV ?? false;

type Variant = "primary" | "emphasis" | "ghost" | "danger" | "secondary" | "plain";
export type ControlWidth = "slot" | "fill" | "content";
export type ButtonContent = "icon" | "text" | "iconText";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "content"> {
  variant?: Variant;
  controlSize?: ControlSize;
  /** Text controls use a registered width slot; containers may explicitly request fill. */
  controlWidth?: ControlWidth;
  /** Icon is content="icon"; text uses the 96px slot; iconText uses the 128px slot. */
  content?: ButtonContent;
  /** Supplies the shared action identity and a fallback label when no children are provided. */
  action?: ActionKey;
  /** Optional explicit label for iconText controls whose visible copy is registered outside ActionKey. */
  label?: ReactNode;
  loading?: boolean;
  /** Toggle/selector state. Applies shared selected styling and button semantics. */
  selected?: boolean;
}

const variantCls: Record<Variant, string> = {
  primary:
    "bg-content-strong text-content-on-light hover:bg-zinc-200 active:bg-zinc-300",
  emphasis:
    "bg-emphasis text-content-on-accent hover:bg-emphasis-hover active:bg-emphasis-active",
  ghost:
    "bg-transparent text-content-primary hover:bg-zinc-800 hover:text-content-strong active:bg-zinc-700",
  danger:
    "bg-transparent text-danger-400 hover:bg-red-950 hover:text-danger-300 active:bg-red-900",
  secondary:
    "bg-control text-content-primary hover:bg-control-hover hover:text-content-strong active:bg-control-active",
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

function IconTextContent({ action, children, label, loading, size }: {
  action?: ActionKey;
  children: ReactNode;
  label?: ReactNode;
  loading?: boolean;
  size: ControlSize;
}) {
  const parts = Children.toArray(children);
  const leading = parts.shift();
  // The registry label always wins, so any child after the icon is silently
  // dropped. That has shipped wrong copy before ("Continue with Apple" rendering
  // as "Sign in"), so fail loudly in dev instead of losing the label quietly.
  if (DEV && parts.length > 0 && (action || label !== undefined)) {
    const dropped = parts
      .map((part) => (typeof part === "string" || typeof part === "number" ? String(part) : "<element>"))
      .join("")
      .trim();
    throw new Error(
      `Button content="iconText" was given both a registered label and extra children; the children never render. ` +
        `Drop them, or register an ActionKey whose label is the copy you want. Discarded: ${JSON.stringify(dropped)}`
    );
  }
  return (
    <>
      <span
        data-button-slot="icon"
        aria-hidden="true"
        className={cn(
          "inline-flex flex-shrink-0 items-center justify-center self-stretch [&>svg]:flex-shrink-0",
          controlSquareClasses[size],
        )}
      >
        {loading ? <LoadingIndicator /> : leading}
      </span>
      <span
        data-button-slot="label"
        className="inline-flex min-w-0 flex-1 items-center justify-center self-stretch px-3"
      >
        {action ? actionLabel(action) : label ?? parts}
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
      label,
      loading,
      selected = false,
      disabled,
      className,
      children,
      role,
      ...props
    },
    ref
  ) => {
    const inheritedSize = useControlSize(controlSize);
    const resolvedSize = inheritedSize;
    // Fill-only labels exceed the 128px slot budget on purpose; rendering one
    // in a slot-width button would truncate it.
    if (DEV && action && isFillActionKey(action) && controlWidth !== "fill") {
      throw new Error(
        `Button action="${action}" carries an unabbreviated label and requires controlWidth="fill".`
      );
    }
    return <button
      ref={ref}
      disabled={disabled || loading}
      data-control-size={resolvedSize}
      data-button-content={content}
      data-control-width={controlWidth}
      aria-busy={loading || undefined}
      role={role}
      aria-pressed={role === "tab" ? undefined : selected || undefined}
      data-selected={selected || undefined}
      className={cn(
        "inline-flex min-w-0 items-center justify-center font-utility font-medium whitespace-nowrap transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:pointer-events-none disabled:opacity-50 select-none cursor-pointer [&>svg]:flex-shrink-0",
        variantCls[variant],
        selected && "bg-control text-content-primary hover:bg-control-hover hover:text-content-strong active:bg-control-active",
        className,
        content === "icon" ? controlSquareClasses[resolvedSize] : controlHeightClasses[resolvedSize],
        controlTextClasses.regular,
        content === "icon"
          ? "rounded-sm p-0"
          : cn(
              "rounded-sm",
              content === "text" ? "gap-2 px-3" : "gap-0 p-0",
              controlWidth === "fill"
                ? "w-full"
                : controlWidth === "content"
                  ? "w-auto max-w-full"
                  : content === "iconText"
                    ? "w-32 max-w-full"
                    : "w-24 max-w-full",
            ),
      )}
      {...props}
    >
      {content === "iconText" ? (
        <IconTextContent action={action} label={label} loading={loading} size={resolvedSize}>{children}</IconTextContent>
      ) : content === "icon" ? (
        loading ? <LoadingIndicator /> : children
      ) : (
        <>{loading && <LoadingIndicator />}{children ?? (action ? actionLabel(action) : null)}</>
      )}
    </button>;
  }
);
Button.displayName = "Button";

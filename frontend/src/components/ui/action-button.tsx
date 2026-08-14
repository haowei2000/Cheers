import { forwardRef } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { actionLabel, type ActionKey } from "./action-labels";
import { Button, type ButtonContent, type ButtonProps } from "./button";
import { controlIconClasses, useControlSize } from "./control-size";

export type CommonActionContext =
  | "windowChrome"
  | "toolbar"
  | "disclosure"
  | "inlineEdit"
  | "form"
  | "dialog"
  | "confirmation";

export type CommonActionKey = Extract<
  ActionKey,
  | "back"
  | "add"
  | "cancel"
  | "close"
  | "collapse"
  | "create"
  | "delete"
  | "edit"
  | "expand"
  | "more"
  | "refresh"
  | "remove"
  | "save"
>;

type Presentation = {
  content: ButtonContent;
  icon?: LucideIcon;
  variant: NonNullable<ButtonProps["variant"]>;
};

const commonActionPresentations = {
  windowChrome: {
    back: { content: "icon", icon: ArrowLeft, variant: "plain" },
    close: { content: "icon", icon: X, variant: "plain" },
    more: { content: "icon", icon: Ellipsis, variant: "plain" },
    refresh: { content: "icon", icon: RefreshCw, variant: "plain" },
  },
  toolbar: {
    add: { content: "icon", icon: Plus, variant: "plain" },
    collapse: { content: "icon", icon: Minimize2, variant: "plain" },
    delete: { content: "icon", icon: Trash2, variant: "danger" },
    expand: { content: "icon", icon: Maximize2, variant: "plain" },
    remove: { content: "icon", icon: X, variant: "danger" },
  },
  disclosure: {
    collapse: { content: "icon", icon: ChevronDown, variant: "plain" },
    expand: { content: "icon", icon: ChevronRight, variant: "plain" },
  },
  inlineEdit: {
    cancel: { content: "icon", icon: X, variant: "plain" },
    delete: { content: "icon", icon: Trash2, variant: "danger" },
    edit: { content: "icon", icon: Pencil, variant: "plain" },
    remove: { content: "icon", icon: X, variant: "danger" },
    save: { content: "icon", icon: Check, variant: "plain" },
  },
  form: {
    back: { content: "text", variant: "secondary" },
    cancel: { content: "text", variant: "secondary" },
    create: { content: "iconText", icon: Plus, variant: "primary" },
    save: { content: "iconText", icon: Save, variant: "primary" },
  },
  dialog: {
    back: { content: "text", variant: "secondary" },
    cancel: { content: "text", variant: "secondary" },
  },
  confirmation: {
    cancel: { content: "text", variant: "secondary" },
    delete: { content: "iconText", icon: Trash2, variant: "danger" },
    remove: { content: "iconText", icon: Trash2, variant: "danger" },
  },
} as const satisfies Record<CommonActionContext, Partial<Record<CommonActionKey, Presentation>>>;

type CommonActionIntent = {
  [C in CommonActionContext]: {
    action: keyof (typeof commonActionPresentations)[C] & CommonActionKey;
    context: C;
  };
}[CommonActionContext];

export type ActionButtonProps = Omit<
  ButtonProps,
  "action" | "children" | "content" | "variant"
> & CommonActionIntent & {
  /** Adds object-specific context to icon-only accessible names, e.g. "Save profile". */
  accessibleLabel?: string;
};

/**
 * Semantic common-action control. Product code declares intent and context;
 * this registry owns icon/text presentation, tone, and the visible action label.
 */
export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(
  ({ action, context, accessibleLabel, controlSize, type = "button", ...props }, ref) => {
    const presentation = (commonActionPresentations[context] as Partial<Record<CommonActionKey, Presentation>>)[action] as Presentation;
    const resolvedSize = useControlSize(controlSize);
    const Icon = presentation.icon;
    const label = accessibleLabel ?? actionLabel(action);
    const icon = Icon ? <Icon className={controlIconClasses[resolvedSize]} aria-hidden="true" /> : null;

    return (
      <Button
        ref={ref}
        type={type}
        action={action}
        content={presentation.content}
        variant={presentation.variant}
        controlSize={resolvedSize}
        {...props}
        aria-label={accessibleLabel ?? props["aria-label"] ?? (presentation.content === "icon" ? label : undefined)}
        title={presentation.content === "icon" ? (props.title ?? label) : props.title}
      >
        {icon}
      </Button>
    );
  },
);
ActionButton.displayName = "ActionButton";

import { forwardRef } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Ellipsis,
  Fingerprint,
  KeyRound,
  Link2,
  LogOut,
  MailQuestion,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  ShieldOff,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Unlink,
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
  | "confirmation"
  | "security"
  | "settings";

export type CommonActionKey = Extract<
  ActionKey,
  | "back"
  | "add"
  | "cancel"
  | "check"
  | "changePassword"
  | "close"
  | "collapse"
  | "copy"
  | "create"
  | "delete"
  | "disable"
  | "dismiss"
  | "done"
  | "edit"
  | "enable"
  | "expand"
  | "forgotPassword"
  | "link"
  | "manageTwoFactor"
  | "more"
  | "open"
  | "refresh"
  | "request"
  | "resolve"
  | "restart"
  | "retry"
  | "review"
  | "remove"
  | "revoke"
  | "save"
  | "setup"
  | "signOut"
  | "switch"
  | "test"
  | "unlink"
  | "update"
>;

type Presentation = {
  content: ButtonContent;
  icon?: LucideIcon;
  /** Registered longer copy for fill-width launchers; compact ActionKey labels stay slot-safe. */
  label?: string;
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
  security: {
    add: { content: "iconText", icon: Fingerprint, variant: "emphasis" },
    changePassword: { content: "iconText", icon: KeyRound, label: "Change password", variant: "secondary" },
    copy: { content: "iconText", icon: Copy, variant: "secondary" },
    disable: { content: "iconText", icon: ShieldOff, variant: "danger" },
    done: { content: "iconText", icon: Check, variant: "emphasis" },
    enable: { content: "iconText", icon: ShieldCheck, variant: "emphasis" },
    forgotPassword: { content: "iconText", icon: MailQuestion, label: "Forgot password", variant: "secondary" },
    link: { content: "iconText", icon: Link2, variant: "secondary" },
    manageTwoFactor: { content: "iconText", icon: ShieldCheck, label: "2FA settings", variant: "secondary" },
    request: { content: "iconText", icon: MailQuestion, variant: "emphasis" },
    revoke: { content: "iconText", icon: X, variant: "danger" },
    setup: { content: "iconText", icon: ShieldCheck, variant: "emphasis" },
    unlink: { content: "iconText", icon: Unlink, variant: "danger" },
    update: { content: "iconText", icon: KeyRound, variant: "emphasis" },
  },
  settings: {
    check: { content: "iconText", icon: RefreshCw, variant: "secondary" },
    disable: { content: "iconText", icon: ToggleLeft, variant: "secondary" },
    dismiss: { content: "text", variant: "secondary" },
    enable: { content: "iconText", icon: ToggleRight, variant: "emphasis" },
    open: { content: "iconText", icon: ArrowUpRight, variant: "secondary" },
    resolve: { content: "text", variant: "emphasis" },
    restart: { content: "iconText", icon: RefreshCw, variant: "emphasis" },
    retry: { content: "iconText", icon: RefreshCw, variant: "secondary" },
    review: { content: "text", variant: "secondary" },
    save: { content: "iconText", icon: Save, variant: "emphasis" },
    signOut: { content: "iconText", icon: LogOut, variant: "danger" },
    switch: { content: "iconText", icon: RefreshCw, variant: "secondary" },
    test: { content: "text", variant: "secondary" },
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
  "action" | "children" | "content" | "label" | "variant"
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
    const visibleLabel = presentation.label;
    const icon = Icon ? <Icon className={controlIconClasses[resolvedSize]} aria-hidden="true" /> : null;

    return (
      <Button
        ref={ref}
        type={type}
        action={visibleLabel ? undefined : action}
        label={visibleLabel}
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

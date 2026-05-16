import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { AppIcon } from "../icons/AppIcon";
import { MemberAvatar, type MemberKind } from "./MemberIdentity";

export type MemberListItemKind = "user" | "bot" | "system";
export type MemberListItemVariant = "panel" | "card";

const MEMBER_COLORS = [
  "#7c6cf5",
  "#3ecf8e",
  "#56a7ff",
  "#f5a623",
  "#f05454",
  "#9586ff",
  "#5b8dff",
];

export function colorForIdentity(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0;
  return MEMBER_COLORS[Math.abs(h) % MEMBER_COLORS.length];
}

export function initialsForIdentity(label: string): string {
  const parts = label.trim().split(/\s+/);
  const first = parts[0]?.[0] || "";
  const second = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + second).toUpperCase() || label.slice(0, 1).toUpperCase() || "?";
}

export function MemberBadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "success" | "danger";
}) {
  return (
    <span className="an-member-badge" data-tone={tone}>
      {children}
    </span>
  );
}

export function MemberListItem({
  id,
  kind = "user",
  username,
  displayName,
  name,
  avatarUrl,
  subtitle,
  meta,
  badges,
  leading,
  actions,
  trailing,
  children,
  selected = false,
  self = false,
  disabled = false,
  compact = false,
  variant = "panel",
  title,
  ariaLabel,
  className,
  onClick,
  asButton,
}: {
  id: string;
  kind?: MemberListItemKind;
  username?: string | null;
  displayName?: string | null;
  name?: ReactNode;
  avatarUrl?: string | null;
  subtitle?: ReactNode;
  meta?: ReactNode;
  badges?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
  selected?: boolean;
  self?: boolean;
  disabled?: boolean;
  compact?: boolean;
  variant?: MemberListItemVariant;
  title?: string;
  ariaLabel?: string;
  className?: string;
  onClick?: () => void;
  asButton?: boolean;
}) {
  const label = displayName || username || (kind === "bot" ? "Bot" : "用户");
  const avatarLabel = label || id;
  const fallbackSubtitle = username && username !== label ? `@${username}` : "";
  const computedSubtitle = subtitle === undefined ? fallbackSubtitle : subtitle;
  const shouldUseButton = asButton ?? Boolean(onClick && !leading && !actions && !children);
  const rootClass = cn(
    "an-member-item",
    `is-${variant}`,
    kind === "bot" && "is-bot",
    selected && "is-selected",
    self && "is-self",
    disabled && "is-disabled",
    compact && "is-compact",
    className,
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onClick || disabled) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick();
    }
  };

  const content = (
    <>
      {leading && <div className="an-member-leading">{leading}</div>}
      <span className="an-member-avatar-wrap">
        <MemberAvatar
          avatarUrl={avatarUrl}
          className="an-member-avatar"
          kind={kind as MemberKind}
          label={avatarLabel}
          size={32}
        />
        {self && (
          <span className="an-member-self-mark" aria-hidden="true">
            <AppIcon name="pencil" />
          </span>
        )}
      </span>
      <div className="an-member-main">
        <div className="an-member-line">
          <span className="an-member-name">{name ?? label}</span>
          {kind === "bot" && <MemberBadge>Bot</MemberBadge>}
          {self && <MemberBadge tone="accent">我</MemberBadge>}
          {badges}
        </div>
        {computedSubtitle && <div className="an-member-sub">{computedSubtitle}</div>}
        {meta && <div className="an-member-meta">{meta}</div>}
        {children && <div className="an-member-extra">{children}</div>}
      </div>
      {actions && <div className="an-member-actions">{actions}</div>}
      {trailing ?? (onClick && !actions ? <span className="an-member-chev">›</span> : null)}
    </>
  );

  if (shouldUseButton) {
    return (
      <button
        type="button"
        className={rootClass}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        onClick={onClick}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className={rootClass}
      title={title}
      aria-label={ariaLabel}
      role={onClick ? "button" : undefined}
      tabIndex={onClick && !disabled ? 0 : undefined}
      onClick={disabled ? undefined : onClick}
      onKeyDown={handleKeyDown}
    >
      {content}
    </div>
  );
}

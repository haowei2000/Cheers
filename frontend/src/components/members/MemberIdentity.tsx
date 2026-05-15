import type { ReactNode } from "react";
import { makeBuiltinAvatarValue } from "../../lib/avatar";
import { AvatarVisual } from "../AvatarVisual";

export type MemberKind = "user" | "bot" | "system";

export type MemberLike = {
  added_by?: string | null;
  avatar_url?: string | null;
  bot_id?: string;
  binding_type?: "http" | "agent_bridge" | string;
  can_manage?: boolean;
  can_manage_template?: boolean;
  connection_status?: string;
  control_connected?: boolean | null;
  data_connected?: boolean | null;
  display_name?: string | null;
  id?: string;
  intro?: string | null;
  is_online?: boolean;
  kind?: MemberKind;
  member_id?: string;
  member_type?: string;
  owner?: {
    user_id?: string;
    username: string;
    display_name?: string | null;
  } | null;
  role?: string;
  scope?: "private" | "friend" | "everyone";
  status?: string;
  template_id?: string | null;
  template_name?: string | null;
  user_id?: string;
  username?: string | null;
};

export function resolveMemberKind(member: MemberLike, fallback: MemberKind = "user"): MemberKind {
  const kind = member.kind || member.member_type;
  if (kind === "bot" || kind === "system" || kind === "user") return kind;
  if (member.bot_id) return "bot";
  if (member.user_id) return "user";
  return fallback;
}

export function resolveMemberId(member: MemberLike): string {
  return member.member_id || member.bot_id || member.user_id || member.id || member.username || "";
}

export function resolveMemberLabel(member: MemberLike, fallbackKind?: MemberKind): string {
  const kind = fallbackKind ?? resolveMemberKind(member);
  return member.display_name || member.username || (kind === "bot" ? "Bot" : kind === "system" ? "系统" : "用户");
}

export function resolveMemberSub(member: MemberLike): string {
  if (member.username) return `@${member.username}`;
  return resolveMemberId(member);
}

export function initialsForMember(label: string): string {
  return [...(label.trim() || "?")].slice(0, 2).join("").toUpperCase();
}

export function memberKindLabel(kind: MemberKind): string {
  if (kind === "bot") return "Bot";
  if (kind === "system") return "系统";
  return "用户";
}

export function memberAccent(kind: MemberKind): string {
  if (kind === "bot") return "var(--green, #2EB67D)";
  if (kind === "system") return "var(--fg-3)";
  return "var(--accent, #1264A3)";
}

export function memberMutedBackground(kind: MemberKind): string {
  if (kind === "bot") return "var(--green-muted, #E9F8F1)";
  if (kind === "system") return "var(--surface-soft)";
  return "var(--accent-muted, #EAF4FF)";
}

export function isMemberOnline(member: MemberLike): boolean {
  const kind = resolveMemberKind(member);
  if (typeof member.is_online === "boolean") return member.is_online;
  if (member.status === "offline") return false;
  if (kind === "bot") {
    if ((member.binding_type || "http") === "agent_bridge") {
      return member.connection_status === "online";
    }
    return member.status !== "offline";
  }
  return member.status === "online";
}

export function MemberPresenceBadge({ member }: { member: MemberLike }) {
  const online = isMemberOnline(member);
  const label = online ? "在线" : "离线";
  return (
    <span
      className="an-member-presence"
      data-online={online ? "true" : "false"}
      title={label}
      aria-label={label}
    />
  );
}

export function sortMembersByKind<T extends MemberLike>(members: T[], currentUserId?: string | null): T[] {
  return members
    .map((member, index) => ({ member, index }))
    .sort((a, b) => {
      const aSelf = Boolean(currentUserId && resolveMemberId(a.member) === currentUserId);
      const bSelf = Boolean(currentUserId && resolveMemberId(b.member) === currentUserId);
      if (aSelf !== bSelf) return aSelf ? -1 : 1;
      const rank = (member: MemberLike) => {
        const kind = resolveMemberKind(member);
        if (kind === "bot") return 0;
        if (kind === "user") return 1;
        return 2;
      };
      const rankDiff = rank(a.member) - rank(b.member);
      return rankDiff || a.index - b.index;
    })
    .map(({ member }) => member);
}

export interface MemberAvatarProps {
  avatarUrl?: string | null;
  className?: string;
  kind?: MemberKind;
  label: string;
  radius?: number | string;
  size?: number;
}

export function MemberAvatar({
  avatarUrl,
  className,
  kind = "user",
  label,
  radius,
  size = 34,
}: MemberAvatarProps) {
  const defaultAvatar =
    kind === "bot"
      ? makeBuiltinAvatarValue("main", "bot")
      : kind === "system"
        ? makeBuiltinAvatarValue("main", "shieldCheck")
        : null;
  return (
    <AvatarVisual
      avatarUrl={avatarUrl || defaultAvatar}
      background={memberAccent(kind)}
      className={className}
      fallback={initialsForMember(label)}
      label={label}
      radius={radius ?? (kind === "user" ? 999 : 9)}
      size={size}
    />
  );
}

export interface MemberBadgeProps {
  kind?: MemberKind;
  label?: string;
}

export function MemberKindBadge({ kind = "user", label }: MemberBadgeProps) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none"
      style={{
        background: memberMutedBackground(kind),
        color: memberAccent(kind),
      }}
    >
      {label ?? memberKindLabel(kind)}
    </span>
  );
}

export interface MemberIdentityProps {
  avatarSize?: number;
  badge?: ReactNode;
  className?: string;
  compact?: boolean;
  kind?: MemberKind;
  member: MemberLike;
  meta?: ReactNode;
  primaryPrefix?: string;
  showBadge?: boolean;
  sub?: ReactNode;
}

export function MemberIdentity({
  avatarSize = 34,
  badge,
  className = "",
  compact = false,
  kind,
  member,
  meta,
  primaryPrefix,
  showBadge = true,
  sub,
}: MemberIdentityProps) {
  const resolvedKind = kind ?? resolveMemberKind(member);
  const label = resolveMemberLabel(member, resolvedKind);
  const subtitle = sub ?? resolveMemberSub(member);

  return (
    <span className={`flex min-w-0 items-center gap-3 ${className}`}>
      <MemberAvatar
        avatarUrl={member.avatar_url}
        kind={resolvedKind}
        label={label}
        size={avatarSize}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-semibold" style={{ color: "var(--fg-1)" }}>
            {primaryPrefix}
            {label}
          </span>
          {showBadge && (badge ?? <MemberKindBadge kind={resolvedKind} />)}
        </span>
        {!compact && subtitle && (
          <span className="mt-0.5 block truncate text-xs" style={{ color: "var(--fg-3)" }}>
            {subtitle}
          </span>
        )}
        {meta && (
          <span className="mt-0.5 block truncate text-xs" style={{ color: "var(--fg-2)" }}>
            {meta}
          </span>
        )}
      </span>
    </span>
  );
}

export interface MemberRowProps extends MemberIdentityProps {
  active?: boolean;
  action?: ReactNode;
  as?: "article" | "button" | "div" | "span";
  leading?: ReactNode;
  onClick?: () => void;
  title?: string;
}

export function MemberRow({
  action,
  active = false,
  as = "div",
  className = "",
  leading,
  onClick,
  title,
  ...identityProps
}: MemberRowProps) {
  const body = (
    <>
      {leading}
      <MemberIdentity {...identityProps} />
      {action && <span className="ml-auto flex shrink-0 items-center gap-2">{action}</span>}
    </>
  );
  const rowClass = `an-row-card ${active ? "is-active" : ""} ${className}`;
  const rowStyle = {
    alignItems: "center",
    background: active ? "var(--accent-muted)" : undefined,
    borderColor: active ? "var(--accent)" : undefined,
    gap: 10,
  };

  if (as === "button") {
    return (
      <button
        type="button"
        className={`${rowClass} w-full text-left`}
        onClick={onClick}
        style={rowStyle}
        title={title}
      >
        {body}
      </button>
    );
  }
  if (as === "article") {
    return (
      <article className={rowClass} style={rowStyle} title={title}>
        {body}
      </article>
    );
  }
  if (as === "span") {
    return (
      <span className={`flex min-w-0 items-center gap-2 ${className}`} title={title}>
        {body}
      </span>
    );
  }
  return (
    <div className={rowClass} style={rowStyle} title={title} onClick={onClick}>
      {body}
    </div>
  );
}

export function MemberSection({
  children,
  count,
  empty,
  title,
}: {
  children: ReactNode;
  count?: number;
  empty?: ReactNode;
  title: string;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--fg-3)" }}>
          {title}
        </h3>
        {typeof count === "number" && <span className="an-chip">{count}</span>}
      </div>
      {count === 0 && empty ? empty : <div className="space-y-2">{children}</div>}
    </section>
  );
}

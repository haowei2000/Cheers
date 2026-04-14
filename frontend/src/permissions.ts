/**
 * 权限工具 — 根据用户角色判断是否拥有某项权限
 *
 * 角色层级（高 → 低）:
 *   system_admin > space_admin > channel_admin > member > guest
 *
 * 权限映射:
 *   user_management   — system_admin
 *   system_settings   — system_admin
 *   space_management  — system_admin, space_admin
 *   channel_management— system_admin, space_admin, channel_admin
 *   bot_config        — system_admin, space_admin
 */

export type UserRole = "system_admin" | "space_admin" | "channel_admin" | "member" | "guest";

export type Permission =
  | "user_management"
  | "system_settings"
  | "space_management"
  | "channel_management"
  | "bot_config";

const ROLE_PERMISSIONS: Record<UserRole, Set<Permission>> = {
  system_admin: new Set([
    "user_management",
    "system_settings",
    "space_management",
    "channel_management",
    "bot_config",
  ]),
  space_admin: new Set([
    "space_management",
    "channel_management",
    "bot_config",
  ]),
  channel_admin: new Set(["channel_management"]),
  member: new Set(),
  guest: new Set(),
};

/** 角色是否拥有指定权限 */
export function hasPermission(role: string | undefined | null, perm: Permission): boolean {
  if (!role) return false;
  const perms = ROLE_PERMISSIONS[role as UserRole];
  return perms ? perms.has(perm) : false;
}

/** 是否至少是 member（非 guest、非未登录） */
export function isMemberOrAbove(role: string | undefined | null): boolean {
  if (!role) return false;
  return role !== "guest";
}

/** 是否为管理员（system_admin 或 space_admin） */
export function isAdmin(role: string | undefined | null): boolean {
  return role === "system_admin" || role === "space_admin";
}

/** 是否为系统管理员 */
export function isSystemAdmin(role: string | undefined | null): boolean {
  return role === "system_admin";
}

/** 获取当前用户角色（从 localStorage） */
export function getStoredRole(): UserRole | null {
  try {
    const stored = localStorage.getItem("currentUser");
    if (!stored) return null;
    const data = JSON.parse(stored);
    if (data.loginTime && Date.now() - data.loginTime < 86400000) {
      return (data.user?.role as UserRole) ?? null;
    }
  } catch {}
  return null;
}

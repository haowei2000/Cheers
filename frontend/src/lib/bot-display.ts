import type { BotItem } from "../types";

export function botInlineStatus(
  bot: Pick<BotItem, "binding_type" | "connection_status" | "is_online" | "status">,
) {
  if ((bot.binding_type || "http") !== "agent_bridge") {
    return bot.is_online === false || bot.status === "offline" ? "Disabled" : "HTTP enabled";
  }
  if (bot.connection_status === "online" && bot.is_online) return "Bridge online";
  if (bot.connection_status === "partial") return "Bridge partially connected";
  return "Bridge offline";
}

export function botScopeText(scope?: BotItem["scope"]) {
  if (scope === "private") return "Private";
  if (scope === "everyone") return "Everyone";
  return "Friend";
}

export function botOwnerText(bot: Pick<BotItem, "owner">) {
  return bot.owner?.display_name || bot.owner?.username || "System";
}

export function introSummary(intro: string | undefined): string {
  if (!intro) return "";
  try {
    const o = JSON.parse(intro);
    if (o.description) return o.description;
    if (Array.isArray(o.capabilities)) return o.capabilities.join(", ");
    return intro.slice(0, 50) + (intro.length > 50 ? "..." : "");
  } catch {
    return intro.slice(0, 50) + (intro.length > 50 ? "..." : "");
  }
}

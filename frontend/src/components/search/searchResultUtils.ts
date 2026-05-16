import type { SearchBotHit, SearchSelection } from "../../types";

export function botScopeText(scope?: SearchBotHit["scope"]) {
  if (scope === "private") return "Private";
  if (scope === "everyone") return "Everyone";
  return "Friend";
}

export function botOwnerText(bot: Pick<SearchBotHit, "owner">) {
  return bot.owner?.display_name || bot.owner?.username || "System";
}

export function channelTypeText(type?: string | null) {
  if (type === "private") return "Private";
  return "Workspace";
}

export function formatBytes(size?: number | null) {
  if (!size || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileTypeText(contentType?: string | null) {
  const ct = contentType || "";
  if (ct.includes("pdf")) return "PDF";
  if (ct.includes("wordprocessingml") || ct.includes("docx")) return "Word";
  if (ct.includes("spreadsheetml") || ct.includes("xlsx")) return "Excel";
  if (ct.startsWith("image/")) return "Image";
  if (ct.startsWith("text/")) return "Text";
  return "Files";
}

export function labelFor(selection: SearchSelection) {
  const { type, item } = selection;
  if (type === "workspace") return item.name;
  if (type === "channel") return item.name;
  if (type === "user") return item.display_name || item.username;
  if (type === "bot") return item.display_name || item.username;
  if (type === "file") return item.original_filename || item.file_id;
  if (type === "todo") return item.content;
  if (type === "task") return item.bot_name || item.task_id;
  return item.snippet || item.channel_name;
}

export function subFor(selection: SearchSelection) {
  const { type, item } = selection;
  if (type === "workspace") return item.kind === "personal" ? "Personal" : "Workspace";
  if (type === "channel") return channelTypeText(item.type);
  if (type === "user") return item.display_name && item.display_name !== item.username ? `@${item.username}` : "";
  if (type === "bot") return `@${item.username} · ${botScopeText(item.scope)} · Owner: ${botOwnerText(item)}`;
  if (type === "file") {
    const size = formatBytes(item.size_bytes);
    return `${item.channel_name || "Channels"} · ${fileTypeText(item.content_type)}${size ? ` · ${size}` : ""}`;
  }
  if (type === "todo") return `${item.channel_name || "Channels"} · ${item.status}`;
  if (type === "task") return `${item.channel_name || "Channels"} · ${item.task_id}`;
  return `${item.channel_name || "Channels"} · ${item.sender_label}`;
}

export function sigilFor(type: SearchSelection["type"]) {
  if (type === "workspace") return "□";
  if (type === "channel") return "#";
  if (type === "user") return "@";
  if (type === "bot") return "⦿";
  if (type === "file") return "";
  if (type === "todo") return "✓";
  if (type === "task") return "↯";
  return "#";
}

export function groupTitle(type: SearchSelection["type"]) {
  if (type === "workspace") return "Workspaces";
  if (type === "channel") return "Channels";
  if (type === "user") return "Members";
  if (type === "bot") return "Bot";
  if (type === "file") return "Files";
  if (type === "todo") return "Todos";
  if (type === "task") return "Tasks";
  return "Messages";
}

export function itemKey(selection: SearchSelection) {
  if (selection.type === "workspace") return `workspace:${selection.item.workspace_id}`;
  if (selection.type === "channel") return `channel:${selection.item.channel_id}`;
  if (selection.type === "user") return `user:${selection.item.user_id}`;
  if (selection.type === "bot") return `bot:${selection.item.bot_id}`;
  if (selection.type === "file") return `file:${selection.item.file_id}`;
  if (selection.type === "todo") return `todo:${selection.item.todo_id}`;
  if (selection.type === "task") return `task:${selection.item.task_id}`;
  return `message:${selection.item.msg_id}`;
}

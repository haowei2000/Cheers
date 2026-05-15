import { API_BASE, getAuthToken } from "../api";

export const AVATAR_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
export const BUILTIN_AVATAR_PREFIX = "builtin:";

export type BuiltinAvatarCategory = "main" | "aiBrand";
export type BuiltinAvatarGroup = "user" | "bot" | "workspace" | "all";

export interface BuiltinAvatarOption {
  background: string;
  category: BuiltinAvatarCategory;
  color: string;
  groups: BuiltinAvatarGroup[];
  label: string;
  name: string;
  value: string;
}

export function makeBuiltinAvatarValue(category: BuiltinAvatarCategory, name: string): string {
  return `${BUILTIN_AVATAR_PREFIX}${category}:${name}`;
}

const builtinAvatarSeeds: Omit<BuiltinAvatarOption, "value">[] = [
  {
    category: "main",
    name: "user",
    label: "用户",
    color: "#1264A3",
    background: "#EAF4FF",
    groups: ["user", "all"],
  },
  {
    category: "main",
    name: "bot",
    label: "Bot",
    color: "#2EB67D",
    background: "#E9F8F1",
    groups: ["bot", "all"],
  },
  {
    category: "main",
    name: "briefcase",
    label: "项目",
    color: "#B45309",
    background: "#FFF7E6",
    groups: ["user", "workspace", "all"],
  },
  {
    category: "main",
    name: "channel",
    label: "频道",
    color: "#0891B2",
    background: "#E8FAFC",
    groups: ["workspace", "bot", "all"],
  },
  {
    category: "main",
    name: "message",
    label: "消息",
    color: "#7C3AED",
    background: "#F3ECFF",
    groups: ["user", "workspace", "all"],
  },
  {
    category: "main",
    name: "memory",
    label: "记忆",
    color: "#0F766E",
    background: "#E7F8F4",
    groups: ["user", "bot", "workspace", "all"],
  },
  {
    category: "main",
    name: "model",
    label: "模型",
    color: "#4F46E5",
    background: "#EEF2FF",
    groups: ["bot", "all"],
  },
  {
    category: "main",
    name: "tools",
    label: "工具",
    color: "#475569",
    background: "#F1F5F9",
    groups: ["bot", "workspace", "all"],
  },
  {
    category: "main",
    name: "shieldCheck",
    label: "管理",
    color: "#C2410C",
    background: "#FFF1E8",
    groups: ["workspace", "all"],
  },
  {
    category: "main",
    name: "zap",
    label: "自动化",
    color: "#D97706",
    background: "#FFF8DB",
    groups: ["bot", "workspace", "all"],
  },
  {
    category: "aiBrand",
    name: "openai",
    label: "OpenAI",
    color: "#111827",
    background: "#F8FAFC",
    groups: ["bot", "all"],
  },
  {
    category: "aiBrand",
    name: "ollama",
    label: "Ollama",
    color: "#111827",
    background: "#F8FAFC",
    groups: ["bot", "all"],
  },
  {
    category: "aiBrand",
    name: "claude",
    label: "Claude",
    color: "#D97757",
    background: "#FFF4ED",
    groups: ["bot", "all"],
  },
  {
    category: "aiBrand",
    name: "anthropic",
    label: "Anthropic",
    color: "#D97757",
    background: "#FFF4ED",
    groups: ["bot", "all"],
  },
  {
    category: "aiBrand",
    name: "gemini",
    label: "Gemini",
    color: "#1A73E8",
    background: "#EAF2FF",
    groups: ["bot", "all"],
  },
  {
    category: "aiBrand",
    name: "deepseek",
    label: "DeepSeek",
    color: "#4D6BFE",
    background: "#EEF2FF",
    groups: ["bot", "all"],
  },
  {
    category: "aiBrand",
    name: "mistral",
    label: "Mistral",
    color: "#FA520F",
    background: "#FFF1E8",
    groups: ["bot", "all"],
  },
  {
    category: "aiBrand",
    name: "qwen",
    label: "Qwen",
    color: "#615CED",
    background: "#F1EFFF",
    groups: ["bot", "all"],
  },
  {
    category: "aiBrand",
    name: "huggingface",
    label: "Hugging Face",
    color: "#D97706",
    background: "#FFF8DB",
    groups: ["bot", "all"],
  },
];

export const builtinAvatarOptions: BuiltinAvatarOption[] = builtinAvatarSeeds.map((option) => ({
  ...option,
  value: makeBuiltinAvatarValue(option.category, option.name),
}));

export function parseBuiltinAvatarValue(value?: string | null): BuiltinAvatarOption | null {
  if (!value?.startsWith(BUILTIN_AVATAR_PREFIX)) return null;
  const [, category, name] = value.split(":");
  if ((category !== "main" && category !== "aiBrand") || !name) return null;
  const existing = builtinAvatarOptions.find(
    (option) => option.category === category && option.name === name,
  );
  if (existing) return existing;
  return {
    background: "#F1F5F9",
    category,
    color: "#475569",
    groups: ["all"],
    label: name,
    name,
    value,
  };
}

export function isBuiltinAvatarValue(value?: string | null): boolean {
  return Boolean(parseBuiltinAvatarValue(value));
}

export function getBuiltinAvatarOptions(group: BuiltinAvatarGroup): BuiltinAvatarOption[] {
  return builtinAvatarOptions.filter((option) => option.groups.includes(group));
}

export async function uploadAvatarImage(
  path: string,
  file: File,
  authToken: string | null,
): Promise<{ avatar_url: string; content_type?: string; size_bytes?: number }> {
  const headers: Record<string, string> = {};
  const token = authToken ?? getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (file.type) headers["Content-Type"] = file.type;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const res = await fetch(`${API_BASE}${suffix}`, {
    method: "POST",
    headers,
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.status === "error") {
    throw new Error(data?.message || data?.detail || "头像上传失败");
  }
  const payload = data?.data || data;
  if (!payload?.avatar_url) throw new Error("头像上传失败");
  return payload;
}

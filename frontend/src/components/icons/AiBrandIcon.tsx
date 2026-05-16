import type { CSSProperties } from "react";
import Anthropic from "@lobehub/icons/es/Anthropic/components/Mono";
import Claude from "@lobehub/icons/es/Claude/components/Mono";
import DeepSeek from "@lobehub/icons/es/DeepSeek/components/Mono";
import Gemini from "@lobehub/icons/es/Gemini/components/Mono";
import HuggingFace from "@lobehub/icons/es/HuggingFace/components/Mono";
import Mistral from "@lobehub/icons/es/Mistral/components/Mono";
import Ollama from "@lobehub/icons/es/Ollama/components/Mono";
import OpenAI from "@lobehub/icons/es/OpenAI/components/Mono";
import Qwen from "@lobehub/icons/es/Qwen/components/Mono";
import type { IconType } from "@lobehub/icons/es/types";

export const aiBrandIconMap = {
  anthropic: Anthropic,
  claude: Claude,
  deepseek: DeepSeek,
  gemini: Gemini,
  huggingface: HuggingFace,
  mistral: Mistral,
  ollama: Ollama,
  openai: OpenAI,
  qwen: Qwen,
} satisfies Record<string, IconType>;

export type AiBrandName = keyof typeof aiBrandIconMap;

const aiBrandAliases: Record<string, AiBrandName> = {
  anthropic: "anthropic",
  claude: "claude",
  claude35sonnet: "claude",
  claude37sonnet: "claude",
  claude3haiku: "claude",
  claude3opus: "claude",
  claude3sonnet: "claude",
  claude4opus: "claude",
  claude4sonnet: "claude",
  claudesonnet: "claude",
  claudeopus: "claude",
  deepseek: "deepseek",
  deepseekchat: "deepseek",
  deepseekcoder: "deepseek",
  gemini: "gemini",
  googleai: "gemini",
  googlegemini: "gemini",
  gpt: "openai",
  gpt35: "openai",
  gpt4: "openai",
  gpt4o: "openai",
  gpt4omini: "openai",
  gpt5: "openai",
  hf: "huggingface",
  huggingface: "huggingface",
  llama: "ollama",
  llama32: "ollama",
  llama33: "ollama",
  mistral: "mistral",
  o1: "openai",
  o3: "openai",
  o4mini: "openai",
  ollama: "ollama",
  openai: "openai",
  qwen: "qwen",
  qwenmax: "qwen",
  qwenvl: "qwen",
  tongyi: "qwen",
};

export const aiBrandColors: Record<AiBrandName, string> = {
  anthropic: "#D97757",
  claude: "#D97757",
  deepseek: "#4D6BFE",
  gemini: "#1A73E8",
  huggingface: "#FFCC4D",
  mistral: "#FA520F",
  ollama: "#111827",
  openai: "#111827",
  qwen: "#615CED",
};

const aiBrandLabels: Record<AiBrandName, string> = {
  anthropic: "Anthropic",
  claude: "Claude",
  deepseek: "DeepSeek",
  gemini: "Gemini",
  huggingface: "Hugging Face",
  mistral: "Mistral",
  ollama: "Ollama",
  openai: "OpenAI",
  qwen: "Qwen",
};

function normalizeIconName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s._-]+/g, "");
}

export function resolveAiBrandName(name?: string | null): AiBrandName | null {
  if (!name) return null;
  const normalized = normalizeIconName(name);
  const exact = aiBrandAliases[normalized];
  if (exact) return exact;

  if (normalized.includes("anthropic")) return "anthropic";
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("deepseek")) return "deepseek";
  if (normalized.includes("gemini") || normalized.includes("googleai")) return "gemini";
  if (normalized.includes("huggingface")) return "huggingface";
  if (normalized.includes("mistral")) return "mistral";
  if (normalized.includes("ollama") || normalized.includes("llama")) return "ollama";
  if (normalized.includes("openai") || normalized.includes("chatgpt") || normalized.includes("gpt")) return "openai";
  if (normalized.includes("qwen") || normalized.includes("tongyi")) return "qwen";
  return null;
}

function fallbackSize(size: number | string): CSSProperties {
  return {
    height: typeof size === "number" ? `${size}px` : size,
    width: typeof size === "number" ? `${size}px` : size,
  };
}

function fallbackFontSize(size: number | string): number | undefined {
  return typeof size === "number" ? Math.max(9, Math.round(size * 0.38)) : undefined;
}

export interface AiBrandIconProps {
  className?: string;
  color?: string;
  fallbackLabel?: string;
  name?: string | null;
  size?: number | string;
  style?: CSSProperties;
  title?: string;
}

export function AiBrandIcon({
  className,
  color,
  fallbackLabel,
  name,
  size = 18,
  style,
  title,
}: AiBrandIconProps) {
  const brandName = resolveAiBrandName(name);

  if (!brandName) {
    const text = (fallbackLabel ?? name ?? "AI").trim().slice(0, 2).toUpperCase() || "AI";

    return (
      <span
        aria-label={title ?? text}
        className={`inline-flex shrink-0 items-center justify-center rounded-md bg-gray-100 font-semibold leading-none text-gray-500 ${
          className ?? ""
        }`}
        role="img"
        style={{ ...fallbackSize(size), fontSize: fallbackFontSize(size), ...style }}
      >
        {text}
      </span>
    );
  }

  const Icon = aiBrandIconMap[brandName];

  return (
    <Icon
      aria-label={title ?? aiBrandLabels[brandName]}
      className={className}
      color={color ?? aiBrandColors[brandName]}
      role="img"
      size={size}
      style={style}
    />
  );
}

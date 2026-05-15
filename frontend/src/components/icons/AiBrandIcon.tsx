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
  claudesonnet: "claude",
  claudeopus: "claude",
  deepseek: "deepseek",
  deepseekchat: "deepseek",
  deepseekcoder: "deepseek",
  gemini: "gemini",
  googleai: "gemini",
  googlegemini: "gemini",
  gpt: "openai",
  gpt4: "openai",
  gpt4o: "openai",
  gpt5: "openai",
  hf: "huggingface",
  huggingface: "huggingface",
  mistral: "mistral",
  ollama: "ollama",
  openai: "openai",
  qwen: "qwen",
  qwenmax: "qwen",
  qwenvl: "qwen",
  tongyi: "qwen",
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
  return aiBrandAliases[normalized] ?? null;
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
      color={color ?? "currentColor"}
      role="img"
      size={size}
      style={style}
    />
  );
}

import type { CSSProperties } from "react";
import { siDocker, siGithub, siGoogle, type SimpleIcon } from "simple-icons";

export const brandIconMap = {
  docker: siDocker,
  github: siGithub,
  google: siGoogle,
} satisfies Record<string, SimpleIcon>;

export type BrandName = keyof typeof brandIconMap;

const brandAliases: Record<string, BrandName> = {
  docker: "docker",
  github: "github",
  githubactions: "github",
  gh: "github",
  google: "google",
  googlecloud: "google",
  gcp: "google",
};

function normalizeBrandName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s._-]+/g, "");
}

export function resolveBrandName(name?: string | null): BrandName | null {
  if (!name) return null;
  const normalized = normalizeBrandName(name);
  return brandAliases[normalized] ?? null;
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

export interface BrandIconProps {
  className?: string;
  color?: string;
  fallbackLabel?: string;
  name?: string | null;
  size?: number | string;
  style?: CSSProperties;
  title?: string;
}

export function BrandIcon({
  className,
  color,
  fallbackLabel,
  name,
  size = 18,
  style,
  title,
}: BrandIconProps) {
  const brandName = resolveBrandName(name);

  if (!brandName) {
    const text = (fallbackLabel ?? name ?? "BR").trim().slice(0, 2).toUpperCase() || "BR";

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

  const icon = brandIconMap[brandName];
  const label = title ?? icon.title;

  return (
    <svg
      aria-label={label}
      className={className}
      fill={color ?? `#${icon.hex}`}
      height={size}
      role="img"
      style={style}
      viewBox="0 0 24 24"
      width={size}
    >
      <title>{label}</title>
      <path d={icon.path} />
    </svg>
  );
}

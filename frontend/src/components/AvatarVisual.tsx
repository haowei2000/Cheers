import type { CSSProperties } from "react";
import { parseBuiltinAvatarValue } from "../lib/avatar";
import { AiBrandIcon } from "./icons/AiBrandIcon";
import { AppIcon, type AppIconName } from "./icons/AppIcon";

interface AvatarVisualProps {
  avatarUrl?: string | null;
  background?: string;
  className?: string;
  color?: string;
  fallback?: string;
  label: string;
  radius?: number | string;
  size?: number;
  style?: CSSProperties;
  title?: string;
}

function fallbackText(label: string, fallback?: string): string {
  const text = fallback ?? [...(label.trim() || "?")].slice(0, 2).join("");
  return text.toUpperCase();
}

export function AvatarVisual({
  avatarUrl,
  background = "var(--accent)",
  className,
  color = "#fff",
  fallback,
  label,
  radius = 8,
  size = 36,
  style,
  title,
}: AvatarVisualProps) {
  const builtin = parseBuiltinAvatarValue(avatarUrl);
  const baseStyle: CSSProperties = {
    width: size,
    height: size,
    borderRadius: radius,
    flexShrink: 0,
    ...style,
  };

  if (builtin) {
    const iconSize = Math.max(14, Math.round(size * 0.54));
    return (
      <span
        aria-label={title ?? label}
        className={`inline-grid place-items-center select-none ${className ?? ""}`}
        role="img"
        style={{
          ...baseStyle,
          background: builtin.background,
          border: "1px solid var(--border)",
          color: builtin.color,
        }}
        title={title ?? label}
      >
        {builtin.category === "aiBrand" ? (
          <AiBrandIcon name={builtin.name} size={iconSize} />
        ) : (
          <AppIcon
            name={builtin.name as AppIconName}
            className="shrink-0"
            size={iconSize}
            style={{ color: builtin.color }}
          />
        )}
      </span>
    );
  }

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={label}
        className={`select-none object-cover ${className ?? ""}`}
        style={baseStyle}
        title={title ?? label}
      />
    );
  }

  const text = fallbackText(label, fallback);
  return (
    <span
      aria-label={title ?? label}
      className={`inline-grid place-items-center select-none font-bold leading-none ${className ?? ""}`}
      role="img"
      style={{
        ...baseStyle,
        background,
        color,
        fontSize: Math.max(10, Math.round(size * (text.length > 1 ? 0.34 : 0.42))),
      }}
      title={title ?? label}
    >
      {text}
    </span>
  );
}

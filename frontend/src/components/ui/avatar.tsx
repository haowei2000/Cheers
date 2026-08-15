import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { initials, avatarColor } from "@/lib/format";
import { agentIconFor, AgentGlyph } from "@/components/ui/agentIcons";
import { resolveServerUrl } from "@/lib/serverConfig";
import { avatarSizeClasses, type ContentSize } from "@/components/ui/content-size";
import { PresenceDot } from "@/components/ui/presence-dot";

interface AvatarProps {
  name?: string | null;
  src?: string | null;
  id?: string;
  size?: ContentSize;
  className?: string;
  /** Presence dot (DESIGN.md §2.7): omit for no dot, true/false for online/offline. */
  online?: boolean;
}

export function Avatar({ name, src, id, size = "regular", className, online }: AvatarProps) {
  const color = id ? avatarColor(id) : "bg-zinc-700";

  let inner: ReactNode;
  if (src) {
    inner = (
      <img
        // Avatar URLs are gateway-relative paths; under the desktop shell
        // (tauri://) they must be absolutized against the configured server.
        src={resolveServerUrl(src)}
        alt={name ?? "avatar"}
        data-design-system-exempt="identity"
        className={cn(
          "rounded-full object-cover flex-shrink-0",
          avatarSizeClasses[size],
          className
        )}
      />
    );
  } else {
    // Well-known agents (claude / codex / gemini / copilot …) get their brand
    // glyph instead of text initials, so a channel full of bots reads by logo.
    const brand = agentIconFor(name);
    inner = brand ? (
      <span
        data-design-system-exempt="identity"
        className={cn(
          "rounded-full flex items-center justify-center flex-shrink-0",
          avatarSizeClasses[size],
          className
        )}
        style={{ backgroundColor: brand.bg, color: brand.fg }}
        title={brand.title}
      >
        <AgentGlyph icon={brand} className="w-[62%] h-[62%]" />
      </span>
    ) : (
      <span
        data-design-system-exempt="identity"
        className={cn(
          "rounded-full flex items-center justify-center font-semibold text-content-on-accent flex-shrink-0",
          avatarSizeClasses[size],
          color,
          className
        )}
      >
        {initials(name)}
      </span>
    );
  }

  if (online === undefined) return inner;
  return (
    <span className="relative inline-flex flex-shrink-0">
      {inner}
      <PresenceDot
        contentSize={size}
        title={online ? "online" : "offline"}
        className={cn(
          "absolute -bottom-0.5 -right-0.5 ring-zinc-900",
          online ? "bg-emerald-500" : "bg-zinc-600"
        )}
      />
    </span>
  );
}

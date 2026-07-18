import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { initials, avatarColor } from "@/lib/format";
import { agentIconFor, AgentGlyph } from "@/components/ui/agentIcons";
import { resolveServerUrl } from "@/lib/serverConfig";

interface AvatarProps {
  name?: string | null;
  src?: string | null;
  id?: string;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
  /** Presence dot (DESIGN.md §2.7): omit for no dot, true/false for online/offline. */
  online?: boolean;
}

const sizeCls = {
  xs: "w-5 h-5 text-[10px]",
  sm: "w-7 h-7 text-xs",
  md: "w-9 h-9 text-sm",
  lg: "w-11 h-11 text-base",
};

function PresenceDot({ online }: { online: boolean }) {
  return (
    <span
      title={online ? "online" : "offline"}
      className={cn(
        "absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-zinc-900",
        online ? "bg-emerald-500" : "bg-zinc-600"
      )}
    />
  );
}

export function Avatar({ name, src, id, size = "md", className, online }: AvatarProps) {
  const color = id ? avatarColor(id) : "bg-zinc-700";

  let inner: ReactNode;
  if (src) {
    inner = (
      <img
        // Avatar URLs are gateway-relative paths; under the desktop shell
        // (tauri://) they must be absolutized against the configured server.
        src={resolveServerUrl(src)}
        alt={name ?? "avatar"}
        className={cn(
          "rounded-full object-cover flex-shrink-0",
          sizeCls[size],
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
        className={cn(
          "rounded-full flex items-center justify-center flex-shrink-0",
          sizeCls[size],
          className
        )}
        style={{ backgroundColor: brand.bg, color: brand.fg }}
        title={brand.title}
      >
        <AgentGlyph icon={brand} className="w-[62%] h-[62%]" />
      </span>
    ) : (
      <span
        className={cn(
          "rounded-full flex items-center justify-center font-semibold text-white flex-shrink-0",
          sizeCls[size],
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
      <PresenceDot online={online} />
    </span>
  );
}

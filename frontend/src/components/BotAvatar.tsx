/* BotAvatar — visual marker for bot senders.
 *
 * Renders a stylized bot face inside a softly-rounded chip so bot replies
 * are immediately distinguishable from human avatars (which use plain
 * rounded-square initials). Falls back to `<img>` when an `avatarUrl` is
 * provided (custom-uploaded bot avatars take precedence). */

interface BotAvatarProps {
  /** Display label, used as alt text + tooltip and for the optional initials fallback. */
  label: string;
  /** Custom uploaded avatar URL; if set, renders <img> and ignores the SVG. */
  avatarUrl?: string | null;
  /** Pixel size; the chip is square (size × size). Defaults to 36. */
  size?: number;
  /** Tile background. Defaults to a subtle accent gradient. */
  background?: string;
  /** Foreground (face) color. Defaults to white. */
  color?: string;
  /** Extra className appended to the wrapper. */
  className?: string;
}

export function BotAvatar({
  label,
  avatarUrl,
  size = 36,
  background,
  color = "#fff",
  className,
}: BotAvatarProps) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={label}
        className={`rounded-xl object-cover ${className ?? ""}`}
        style={{ width: size, height: size }}
      />
    );
  }

  // Soft mint-to-emerald gradient ⇒ matches the existing "Bot" tag color
  // (#2EB67D) used elsewhere in the message header.
  const bg = background ?? "linear-gradient(135deg, #34c98c 0%, #2EB67D 60%, #218057 100%)";
  // Internal SVG is drawn on a 24×24 grid then scaled into the chip.
  return (
    <div
      role="img"
      aria-label={label}
      title={label}
      className={`rounded-xl flex items-center justify-center select-none flex-shrink-0 ${className ?? ""}`}
      style={{
        width: size,
        height: size,
        background: bg,
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width={Math.round(size * 0.62)}
        height={Math.round(size * 0.62)}
        fill="none"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {/* Antenna */}
        <line x1="12" y1="3" x2="12" y2="6" />
        <circle cx="12" cy="2.6" r="1.1" fill={color} stroke="none" />
        {/* Head: rounded-square chassis */}
        <rect x="4" y="6" width="16" height="13" rx="3.5" />
        {/* Eyes — solid dots, slightly bright */}
        <circle cx="9" cy="12.2" r="1.5" fill={color} stroke="none" />
        <circle cx="15" cy="12.2" r="1.5" fill={color} stroke="none" />
        {/* Mouth — short calm line */}
        <line x1="9.5" y1="16" x2="14.5" y2="16" />
        {/* Side ports */}
        <line x1="3" y1="11" x2="3" y2="14" />
        <line x1="21" y1="11" x2="21" y2="14" />
      </svg>
    </div>
  );
}

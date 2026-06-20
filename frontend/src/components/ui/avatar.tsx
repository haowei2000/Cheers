import { cn } from "@/lib/cn";
import { initials, avatarColor } from "@/lib/format";

interface AvatarProps {
  name?: string | null;
  src?: string | null;
  id?: string;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}

const sizeCls = {
  xs: "w-5 h-5 text-[10px]",
  sm: "w-7 h-7 text-xs",
  md: "w-9 h-9 text-sm",
  lg: "w-11 h-11 text-base",
};

export function Avatar({ name, src, id, size = "md", className }: AvatarProps) {
  const color = id ? avatarColor(id) : "bg-zinc-700";

  if (src) {
    return (
      <img
        src={src}
        alt={name ?? "avatar"}
        className={cn(
          "rounded-full object-cover flex-shrink-0",
          sizeCls[size],
          className
        )}
      />
    );
  }

  return (
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

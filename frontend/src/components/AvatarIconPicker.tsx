import {
  getBuiltinAvatarOptions,
  type BuiltinAvatarGroup,
} from "../lib/avatar";
import { AvatarVisual } from "./AvatarVisual";

interface AvatarIconPickerProps {
  disabled?: boolean;
  group: BuiltinAvatarGroup;
  onChange: (value: string) => void;
  value?: string | null;
}

export function AvatarIconPicker({
  disabled = false,
  group,
  onChange,
  value,
}: AvatarIconPickerProps) {
  const options = getBuiltinAvatarOptions(group);

  return (
    <div
      aria-label="内置头像图标"
      className="grid grid-cols-[repeat(auto-fill,minmax(38px,1fr))] gap-2"
      role="group"
    >
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-label={`选择${option.label}`}
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            title={option.label}
            className="inline-grid h-10 min-w-10 place-items-center rounded-lg border transition-colors"
            style={{
              background: active ? "var(--accent-muted)" : "var(--bg-0)",
              borderColor: active ? "var(--accent)" : "var(--border)",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.55 : 1,
            }}
          >
            <AvatarVisual
              avatarUrl={option.value}
              label={option.label}
              radius={7}
              size={28}
            />
          </button>
        );
      })}
    </div>
  );
}

import type { BotRow, BotScope } from "./types";
import { MemberPresenceBadge } from "../../../components/members";

const BOT_SCOPE_OPTIONS: { value: BotScope; label: string; hint: string }[] = [
  { value: "private", label: "Private", hint: "Only you can start DMs or invite" },
  { value: "friend", label: "Friend", hint: "You and friends can start DMs or invite" },
  { value: "everyone", label: "Everyone", hint: "All users can start DMs or invite" },
];

export function normalizeBotScope(scope?: string | null): BotScope {
  if (scope === "private" || scope === "friend" || scope === "everyone") return scope;
  return "friend";
}

export function botScopeLabel(scope?: string | null) {
  const normalized = normalizeBotScope(scope);
  const found = BOT_SCOPE_OPTIONS.find((x) => x.value === normalized);
  return found?.label || "Friend";
}

export function botOwnerLabel(bot: Pick<BotRow, "owner" | "created_by">) {
  return bot.owner?.display_name || bot.owner?.username || bot.created_by || "System";
}

export function BotScopeControl({
  value,
  onChange,
  disabled = false,
}: {
  value: BotScope;
  onChange: (scope: BotScope) => void;
  disabled?: boolean;
}) {
  const current = BOT_SCOPE_OPTIONS.find((opt) => opt.value === value) || BOT_SCOPE_OPTIONS[1];
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div
        className="an-seg"
        role="radiogroup"
        aria-label="Bot Scope"
        style={{ display: "inline-flex", justifySelf: "start" }}
      >
        {BOT_SCOPE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={value === opt.value ? "on" : ""}
            onClick={() => onChange(opt.value)}
            disabled={disabled}
            role="radio"
            aria-checked={value === opt.value}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div className="an-rc-sub" style={{ marginTop: 0 }}>
        {current.hint}
      </div>
    </div>
  );
}

export function BotOnlineBadge({ bot }: { bot: BotRow }) {
  return (
    <MemberPresenceBadge
      member={{
        ...bot,
        member_id: bot.bot_id,
        member_type: "bot",
      }}
    />
  );
}

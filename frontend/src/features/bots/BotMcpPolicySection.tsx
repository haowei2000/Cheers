import { useEffect, useState } from "react";
import { getBotMcpPolicy, updateBotMcpPolicy } from "@/api/bots";
import { SectionHead } from "@/components/ui/field";
import { SurfaceSpinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { messageOf, notify } from "@/lib/notify";

/**
 * Owner opt-out for MCP narrowing (docs/arch/MCP_AUTH_ISOLATION.md §5): on a
 * person's task the bot's MCP calls use the lower of its role and theirs.
 * Turning it off lets read-only members drive automation that writes.
 */
export function BotMcpPolicySection({ botId }: { botId: string }) {
  const [narrow, setNarrow] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setNarrow(null);
    getBotMcpPolicy(botId)
      .then((policy) => live && setNarrow(policy.narrow_to_sender))
      .catch((e) => notify.error(messageOf(e)));
    return () => {
      live = false;
    };
  }, [botId]);

  if (narrow === null) return <SurfaceSpinner />;

  const change = (next: boolean) => {
    setBusy(true);
    updateBotMcpPolicy(botId, next)
      .then((policy) => setNarrow(policy.narrow_to_sender))
      .catch((e) => notify.error(messageOf(e)))
      .finally(() => setBusy(false));
  };

  return <McpNarrowSwitch narrow={narrow} busy={busy} onChange={change} />;
}

export function McpNarrowSwitch({
  narrow,
  busy,
  onChange,
}: {
  narrow: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <section className="space-y-3">
      <SectionHead
        className="mb-0"
        tip="Applies to MCP tokens issued after the change. The bot's normal replies are not affected."
      >
        Tool access on behalf of people
      </SectionHead>
      <Switch
        label="Limit tools to the requester's role"
        stateText={
          narrow
            ? "On: when someone asks the bot, its tools can do only what that person could do in the channel."
            : "Off: the bot's tools use the bot's own role, even when a read-only member asks."
        }
        checked={narrow}
        disabled={busy}
        onChange={(e) => onChange(e.target.checked)}
      />
    </section>
  );
}

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { ChevronDown, Radio } from "lucide-react";
import { getBotMonitoring, updateBotMonitoring, type BotMonitoring } from "@/api/taskClaims";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ItemSection, OperationsItem } from "@/components/ui/item";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { MemberItem } from "@/types";

const defaults: Omit<BotMonitoring, "channel_id" | "bot_id"> = {
  mode: "off",
  scope: "",
  debounce_seconds: 15,
  min_interval_seconds: 60,
  max_evaluations_per_hour: 20,
  batch_size: 8,
  confidence_threshold: 0.75,
};

export function TaskClaimSettings({
  channelId,
  bots,
}: {
  channelId: string;
  bots: MemberItem[];
}) {
  const [selected, setSelected] = useState("");
  const [policy, setPolicy] = useState(defaults);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (!selected && bots[0]) setSelected(bots[0].member_id);
  }, [bots, selected]);

  useEffect(() => {
    if (!selected) return;
    getBotMonitoring(channelId, selected)
      .then(({ channel_id: _, bot_id: __, ...nextPolicy }) => setPolicy(nextPolicy))
      .catch(() => setPolicy(defaults));
  }, [channelId, selected]);

  if (!bots.length) return null;

  const save = async () => {
    setSaving(true);
    try {
      const { channel_id: _, bot_id: __, ...nextPolicy } = await updateBotMonitoring(
        channelId,
        selected,
        policy
      );
      setPolicy(nextPolicy);
      toast.success("Task monitoring saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save monitoring");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="border-t border-zinc-800 pt-3">
      <ItemSection label="Claims" controlSize="regular">
        <div role="listitem">
          <OperationsItem
            presentationLevel="max"
            controlSize="comfortable"
            leading={<Radio className="h-4 w-4 text-zinc-400" />}
            title="Proactive task claiming"
            subtitle="A bot can inspect activity and ask before starting work."
            metadata="Human approval is always required."
            criticalStatus={
              <span className="font-utility text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                {policy.mode === "off" ? "Off" : "Active"}
              </span>
            }
            trailing={
              <ChevronDown
                className={`h-4 w-4 text-zinc-500 transition-transform ${expanded ? "rotate-180" : ""}`}
              />
            }
            className={expanded ? "border-l-zinc-200 bg-zinc-900 text-zinc-100" : undefined}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          />

          {expanded && (
            <div className="space-y-3 border-b border-zinc-800/90 px-2 py-3">
              <fieldset className="space-y-3" aria-label="Task claiming policy">
                <label className="block font-utility text-xs text-zinc-400">
                  Bot
                  <Select
                    value={selected}
                    onChange={(event) => setSelected(event.target.value)}
                    className="mt-1"
                  >
                    {bots.map((bot) => (
                      <option key={bot.member_id} value={bot.member_id}>
                        {bot.display_name || bot.username || bot.member_id.slice(0, 8)}
                      </option>
                    ))}
                  </Select>
                </label>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="font-utility text-xs text-zinc-400">
            Listen to
            <Select
              value={policy.mode}
              onChange={(event) =>
                setPolicy({ ...policy, mode: event.target.value as BotMonitoring["mode"] })
              }
              className="mt-1"
            >
              <option value="off">Off</option>
              <option value="text">Text messages</option>
              <option value="text_and_transcript">Text + voice transcript</option>
              <option value="all_activity">All activity</option>
            </Select>
          </label>
          <label className="font-utility text-xs text-zinc-400">
            Debounce (seconds)
            <Input
              type="number"
              min={1}
              max={3600}
              value={policy.debounce_seconds}
              onChange={(event) =>
                setPolicy({ ...policy, debounce_seconds: Number(event.target.value) })
              }
              className="mt-1"
            />
          </label>
          <label className="font-utility text-xs text-zinc-400">
            Minimum interval
            <Input
              type="number"
              min={1}
              value={policy.min_interval_seconds}
              onChange={(event) =>
                setPolicy({ ...policy, min_interval_seconds: Number(event.target.value) })
              }
              className="mt-1"
            />
          </label>
          <label className="font-utility text-xs text-zinc-400">
            Checks per hour
            <Input
              type="number"
              min={1}
              max={1000}
              value={policy.max_evaluations_per_hour}
              onChange={(event) =>
                setPolicy({ ...policy, max_evaluations_per_hour: Number(event.target.value) })
              }
              className="mt-1"
            />
          </label>
                </div>

                <label className="block font-utility text-xs text-zinc-400">
                  Bot responsibility scope
                  <Textarea
                    rows={3}
                    value={policy.scope}
                    placeholder="Example: frontend implementation, UI bugs, and accessibility"
                    onChange={(event) => setPolicy({ ...policy, scope: event.target.value })}
                    className="mt-1 resize-none"
                  />
                </label>
              </fieldset>

              <div className="flex justify-end">
                <Button controlSize="regular" loading={saving} onClick={() => void save()}>
                  Save monitoring
                </Button>
              </div>
            </div>
          )}
        </div>
      </ItemSection>
    </section>
  );
}

import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import {
  getBotSocialPolicy,
  updateBotSocialPolicy,
  type BotSocialPolicy,
} from "@/api/bots";
import { Field, SectionHead } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { SurfaceSpinner } from "@/components/ui/spinner";

export function BotSocialAccessSection({ botId }: { botId: string }) {
  const [policy, setPolicy] = useState<BotSocialPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [visibility, setVisibility] = useState<"public" | "friends" | "private">("public");
  const [friendPolicy, setFriendPolicy] = useState<"open" | "require_approval" | "disabled">("open");
  const [invitePolicy, setInvitePolicy] = useState<"open" | "require_approval">("require_approval");

  const load = useCallback(() => {
    setLoading(true);
    getBotSocialPolicy(botId)
      .then((p) => {
        setPolicy(p);
        setVisibility(p.visibility);
        setFriendPolicy(p.friend_policy);
        setInvitePolicy(p.invite_policy);
      })
      .catch(() => toast.error("Failed to load social policy"))
      .finally(() => setLoading(false));
  }, [botId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleVisibilityChange(next: "public" | "friends" | "private") {
    setVisibility(next);
    setBusy(true);
    try {
      const updated = await updateBotSocialPolicy(botId, { visibility: next });
      setPolicy(updated);
      toast.success("Discovery visibility updated");
    } catch {
      toast.error("Failed to update visibility");
    } finally {
      setBusy(false);
    }
  }

  async function handleFriendPolicyChange(next: "open" | "require_approval" | "disabled") {
    setFriendPolicy(next);
    setBusy(true);
    try {
      const updated = await updateBotSocialPolicy(botId, { friend_policy: next });
      setPolicy(updated);
      toast.success("Friend request policy updated");
    } catch {
      toast.error("Failed to update friend request policy");
    } finally {
      setBusy(false);
    }
  }

  async function handleInvitePolicyChange(next: "open" | "require_approval") {
    setInvitePolicy(next);
    setBusy(true);
    try {
      const updated = await updateBotSocialPolicy(botId, { invite_policy: next });
      setPolicy(updated);
      toast.success("Channel invitation policy updated");
    } catch {
      toast.error("Failed to update invitation policy");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <SurfaceSpinner />;
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <SectionHead className="mb-0" tip="Configure how other users and channels discover, interact with, and invite this bot.">
          Social Access
        </SectionHead>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Search Discovery"
          tip="Controls who can find and view this bot in global search and member directories."
        >
          <Select
            value={visibility}
            disabled={busy}
            onChange={(e) => void handleVisibilityChange(e.target.value as "public" | "friends" | "private")}
            controlSize="regular"
          >
            <option value="public">Public (Anyone can search)</option>
            <option value="friends">Friends only</option>
            <option value="private">Private (Hidden from search)</option>
          </Select>
        </Field>

        <Field
          label="Friend Requests"
          tip="Controls policy when another user sends a direct friend request to this bot."
        >
          <Select
            value={friendPolicy}
            disabled={busy}
            onChange={(e) => void handleFriendPolicyChange(e.target.value as "open" | "require_approval" | "disabled")}
            controlSize="regular"
          >
            <option value="open">Auto-accept (Open)</option>
            <option value="require_approval">Require approval</option>
            <option value="disabled">Disabled (Reject requests)</option>
          </Select>
        </Field>

        <Field
          label="Channel Invitations"
          tip="Controls authorization policy when members invite this bot into a group or channel."
          className="sm:col-span-2"
        >
          <Select
            value={invitePolicy}
            disabled={busy}
            onChange={(e) => void handleInvitePolicyChange(e.target.value as "open" | "require_approval")}
            controlSize="regular"
          >
            <option value="open">Direct join (Open)</option>
            <option value="require_approval">Require approval (Owner confirmation)</option>
          </Select>
        </Field>
      </div>
    </section>
  );
}

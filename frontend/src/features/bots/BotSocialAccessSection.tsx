import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { getBotSocialPolicy, updateBotSocialPolicy } from "@/api/bots";
import { Field, SectionHead } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { SurfaceSpinner } from "@/components/ui/spinner";

export function BotSocialAccessSection({ botId }: { botId: string }) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [visibility, setVisibility] = useState<"public" | "friends" | "private">("public");
  const [friendPolicy, setFriendPolicy] = useState<"open" | "require_approval" | "disabled">("open");
  const [invitePolicy, setInvitePolicy] = useState<"open" | "require_approval">("require_approval");

  const load = useCallback(() => {
    setLoading(true);
    getBotSocialPolicy(botId)
      .then((p) => {
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

  async function savePolicy(
    patch: Parameters<typeof updateBotSocialPolicy>[1],
    success: string,
    failure: string,
  ) {
    setBusy(true);
    try {
      await updateBotSocialPolicy(botId, patch);
      toast.success(success);
    } catch {
      toast.error(failure);
    } finally {
      setBusy(false);
    }
  }

  function handleVisibilityChange(next: "public" | "friends" | "private") {
    setVisibility(next);
    return savePolicy({ visibility: next }, "Discovery visibility updated", "Failed to update visibility");
  }

  function handleFriendPolicyChange(next: "open" | "require_approval" | "disabled") {
    setFriendPolicy(next);
    return savePolicy(
      { friend_policy: next },
      "Friend request policy updated",
      "Failed to update friend request policy",
    );
  }

  function handleInvitePolicyChange(next: "open" | "require_approval") {
    setInvitePolicy(next);
    return savePolicy(
      { invite_policy: next },
      "Channel invitation policy updated",
      "Failed to update invitation policy",
    );
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

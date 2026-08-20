import { useChannelProfile } from "@/hooks/useChannelProfile";
import { panelsFor } from "@/features/chat/panels/registry";
import "@/features/chat/panels/builtin/githubCode";

/** Header-surface panels for this channel's profile. The header has no resource
 *  channel of its own — it also renders inside ChannelPreview — so the context it
 *  builds omits `sendResourceReq`. Header panels read `ctx.profile`. */
export function ChannelHeaderSlot({ channelId }: { channelId: string }) {
  const profile = useChannelProfile(channelId);

  if (!profile) return null;
  return (
    <>
      {panelsFor("header", profile.profile).map((panel) => (
        <div key={panel.id}>{panel.render({ channelId, profile })}</div>
      ))}
    </>
  );
}

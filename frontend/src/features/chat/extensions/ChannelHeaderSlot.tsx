import { useChannelProfile } from "@/hooks/useChannelProfile";
import { channelHeadersFor } from "./channelSlots";
import "./githubCode";

export function ChannelHeaderSlot({ channelId }: { channelId: string }) {
  const profile = useChannelProfile(channelId);

  if (!profile) return null;
  return (
    <>
      {channelHeadersFor(profile.profile).map(({ id, component: Component }) => (
        <Component key={id} channelId={channelId} profile={profile} />
      ))}
    </>
  );
}

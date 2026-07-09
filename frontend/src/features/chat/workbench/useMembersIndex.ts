// Channel roster index for ViewBoards that receive opaque ids (bot_id,
// actor_id …) from resource verbs and want to show a name + avatar instead.
// Fetched from REST listChannelMembers (which carries avatar_url — the
// channel.members resource verb does not). Best-effort: on failure the map is
// just empty and callers fall back to short ids.
import { useEffect, useMemo, useState } from "react";
import { listChannelMembers } from "@/api/channels";
import type { MemberItem } from "@/types";

export type MembersIndex = Map<string, MemberItem>;

export function useMembersIndex(channelId: string): MembersIndex {
  const [members, setMembers] = useState<MemberItem[]>([]);

  useEffect(() => {
    let alive = true;
    listChannelMembers(channelId)
      .then((m) => alive && setMembers(m ?? []))
      .catch(() => alive && setMembers([]));
    return () => {
      alive = false;
    };
  }, [channelId]);

  return useMemo(() => {
    const map = new Map<string, MemberItem>();
    for (const m of members) map.set(m.member_id, m);
    return map;
  }, [members]);
}

/** Display label for a member id: name if known, short id otherwise. */
export function memberLabel(map: Map<string, MemberItem>, id?: string | null): string {
  if (!id) return "";
  const m = map.get(id);
  return m?.display_name || m?.username || id.slice(0, 8);
}

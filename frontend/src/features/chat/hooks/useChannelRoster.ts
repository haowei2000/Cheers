import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from "react";
import { listChannelMembers, listVoiceTranscript } from "@/api/channels";
import type { Channel, MemberItem, VoiceTranscriptSegment } from "@/types";
import { getChannelCache, setChannelCache } from "../chatCache";
import type { MentionCandidate } from "../MessageComposer";
import type { ProfileData } from "../ProfileHovercard";

export function useChannelRoster({
  channel,
  preview,
  activeChannelRef,
}: {
  channel: Channel | null;
  preview: boolean;
  activeChannelRef: MutableRefObject<string | null>;
}) {
  const channelId = channel?.channel_id;
  const channelKind = channel?.kind;
  const [mentionables, setMentionables] = useState<MentionCandidate[]>([]);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [voiceTranscripts, setVoiceTranscripts] = useState<VoiceTranscriptSegment[]>([]);

  useEffect(() => {
    if (!channelId || preview) {
      setMentionables([]);
      setMembers([]);
      return;
    }
    const apply = (rows: MemberItem[]) => {
      setMembers(rows);
      setMentionables(
        rows
          .filter((member) => member.member_type === "user" || member.member_type === "bot")
          .map((member) => ({
            id: member.member_id,
            type: member.member_type === "bot" ? ("bot" as const) : ("user" as const),
            label: member.display_name || member.username || member.member_id.slice(0, 8),
            sublabel: member.username,
            canReceiveAudio: member.can_receive_audio ?? false,
            isOnline: member.is_online,
          })),
      );
    };
    const cached = getChannelCache(channelId)?.members;
    if (cached) apply(cached);
    void listChannelMembers(channelId)
      .then((rows) => {
        if (activeChannelRef.current !== channelId) return;
        setChannelCache(channelId, { members: rows });
        apply(rows);
      })
      .catch(() => {
        if (activeChannelRef.current === channelId && !cached) {
          setMembers([]);
          setMentionables([]);
        }
      });
  }, [activeChannelRef, channelId, preview]);

  const memberById = useMemo<Map<string, ProfileData>>(
    () => new Map(members.map((member) => [member.member_id, member])),
    [members],
  );
  const voiceSpeakerNames = useMemo(
    () =>
      Object.fromEntries(
        members.map((member) => [
          member.member_id,
          member.display_name || member.username || "Member",
        ]),
      ),
    [members],
  );

  const loadVoiceTranscript = useCallback(async () => {
    if (!channelId || channelKind !== "voice" || preview) {
      setVoiceTranscripts([]);
      return;
    }
    try {
      const segments = await listVoiceTranscript(channelId);
      if (activeChannelRef.current === channelId) setVoiceTranscripts(segments);
    } catch {
      if (activeChannelRef.current === channelId) setVoiceTranscripts([]);
    }
  }, [activeChannelRef, channelId, channelKind, preview]);

  useEffect(() => {
    void loadVoiceTranscript();
  }, [loadVoiceTranscript]);

  return {
    mentionables,
    setMentionables,
    members,
    setMembers,
    memberById,
    voiceSpeakerNames,
    voiceTranscripts,
    setVoiceTranscripts,
    loadVoiceTranscript,
  };
}

import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { AuthFetch } from "../../../api/client";
import { API } from "../../../lib/app-config";
import type { BotItem, Channel, ChannelBot, ChannelUser } from "../../../types";

interface UseChannelParticipantsOptions {
  selectedId: string | null;
  channels: Channel[];
  addBotOpen: boolean;
  authToken: string | null;
  authFetch: AuthFetch;
  selectedIdRef: MutableRefObject<string | null>;
}

type MemberPayload = {
  member_id: string;
  member_type: string;
  username?: string;
  avatar_url?: string;
  display_name?: string;
  scope?: BotItem["scope"];
  owner?: BotItem["owner"];
};

type ParticipantCacheEntry = {
  bots: ChannelBot[];
  users: ChannelUser[];
  receivedAt: number;
};

const PARTICIPANT_CACHE_REVALIDATE_MS = 15_000;
const PARTICIPANT_FETCH_DELAY_MS = 120;
const PARTICIPANT_REVALIDATE_DELAY_MS = 400;

function mapBots(items: MemberPayload[]): ChannelBot[] {
  return items
    .filter((member) => member.member_type === "bot" && member.username)
    .map((member) => ({
      member_id: member.member_id,
      username: member.username!,
      avatar_url: member.avatar_url,
      display_name: member.display_name,
      scope: member.scope,
      owner: member.owner,
    }));
}

function mapUsers(items: MemberPayload[]): ChannelUser[] {
  return items
    .filter((member) => member.member_type === "user" && member.username)
    .map((member) => ({
      member_id: member.member_id,
      username: member.username!,
      avatar_url: member.avatar_url,
      display_name: member.display_name,
      scope: member.scope,
      owner: member.owner,
    }));
}

export function useChannelParticipants({
  selectedId,
  channels,
  addBotOpen,
  authToken,
  authFetch,
  selectedIdRef,
}: UseChannelParticipantsOptions) {
  const [autoAssist, setAutoAssist] = useState(false);
  const [channelBots, setChannelBots] = useState<ChannelBot[]>([]);
  const [channelUsers, setChannelUsers] = useState<ChannelUser[]>([]);
  const [allBots, setAllBots] = useState<BotItem[]>([]);
  const [selectedBotIds, setSelectedBotIds] = useState<Set<string>>(new Set());
  const [addingBots, setAddingBots] = useState(false);
  const participantCacheRef = useRef<Partial<Record<string, ParticipantCacheEntry>>>({});

  useEffect(() => {
    if (!selectedId) {
      setAutoAssist(false);
      return;
    }
    const targetChannelId = selectedId;
    const channel = channels.find((item) => item.channel_id === targetChannelId);
    setAutoAssist(channel?.auto_assist ?? false);
  }, [channels, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setChannelBots([]);
      setChannelUsers([]);
      return;
    }
    const targetChannelId = selectedId;
    const controller = new AbortController();
    let fetchTimer: ReturnType<typeof setTimeout> | null = null;
    const cached = participantCacheRef.current[targetChannelId];
    if (cached) {
      setChannelBots(cached.bots);
      setChannelUsers(cached.users);
      if (Date.now() - cached.receivedAt < PARTICIPANT_CACHE_REVALIDATE_MS) {
        return () => controller.abort();
      }
    } else {
      setChannelBots([]);
      setChannelUsers([]);
    }

    const fetchMembers = () => {
      authFetch(`${API}/channels/${targetChannelId}/members?with_username=1`, {
        signal: controller.signal,
      })
        .then((response) => response.json())
        .then((data) => {
          if (
            controller.signal.aborted ||
            selectedIdRef.current !== targetChannelId
          ) {
            return;
          }
          if (data.data) {
            const bots = mapBots(data.data);
            const users = mapUsers(data.data);
            participantCacheRef.current[targetChannelId] = {
              bots,
              users,
              receivedAt: Date.now(),
            };
            setChannelBots(bots);
            setChannelUsers(users);
          } else {
            participantCacheRef.current[targetChannelId] = {
              bots: [],
              users: [],
              receivedAt: Date.now(),
            };
            setChannelBots([]);
            setChannelUsers([]);
          }
        })
        .catch((error) => {
          if ((error as { name?: string }).name === "AbortError") return;
          if (selectedIdRef.current !== targetChannelId) return;
          setChannelBots([]);
          setChannelUsers([]);
        });
    };

    fetchTimer = setTimeout(
      fetchMembers,
      cached ? PARTICIPANT_REVALIDATE_DELAY_MS : PARTICIPANT_FETCH_DELAY_MS,
    );

    return () => {
      if (fetchTimer) clearTimeout(fetchTimer);
      controller.abort();
    };
  }, [authFetch, selectedId, selectedIdRef]);

  useEffect(() => {
    if (!addBotOpen) return;
    const headers: Record<string, string> = authToken
      ? { Authorization: `Bearer ${authToken}` }
      : {};
    fetch(`${API}/bots`, { headers })
      .then((response) => response.json())
      .then((data) => setAllBots(data.data || []))
      .catch(() => setAllBots([]));
    setSelectedBotIds(new Set());
  }, [addBotOpen, authToken]);

  const addBotToChannel = (botId: string): Promise<void> => {
    if (!selectedId) return Promise.resolve();
    return authFetch(`${API}/channels/${selectedId}/members`, {
      method: "POST",
      body: JSON.stringify({ member_id: botId, member_type: "bot" }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (data.status !== "success") return;
        authFetch(`${API}/channels/${selectedId}/members?with_username=1`)
          .then((response) => response.json())
          .then((nextData) => {
            if (nextData.data) {
              const bots = mapBots(nextData.data);
              const users = mapUsers(nextData.data);
              participantCacheRef.current[selectedId] = {
                bots,
                users,
                receivedAt: Date.now(),
              };
              setChannelBots(bots);
              setChannelUsers(users);
            }
          });
      })
      .catch(console.error);
  };

  const removeBotFromChannel = (memberId: string) => {
    if (!selectedId) return;
    authFetch(
      `${API}/channels/${selectedId}/members/${encodeURIComponent(memberId)}`,
      { method: "DELETE" },
    )
      .then((response) => response.json())
      .then((data) => {
        if (data.status === "success") {
          setChannelBots((prev) => {
            const bots = prev.filter((bot) => bot.member_id !== memberId);
            const cached = participantCacheRef.current[selectedId];
            if (cached) {
              participantCacheRef.current[selectedId] = {
                ...cached,
                bots,
                receivedAt: Date.now(),
              };
            }
            return bots;
          });
        }
      })
      .catch(console.error);
  };

  return {
    autoAssist,
    setAutoAssist,
    channelBots,
    channelUsers,
    allBots,
    selectedBotIds,
    setSelectedBotIds,
    addingBots,
    setAddingBots,
    addBotToChannel,
    removeBotFromChannel,
  };
}

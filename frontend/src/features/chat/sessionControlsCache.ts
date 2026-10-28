import {
  getSessionControls,
  listChannelBotSessions,
  type SessionControls,
  type SessionInfo,
} from "@/api/sessionControl";
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient, queryKeys } from "@/lib/queryClient";
import { agentOptionsQueryPolicy, discoveryRefetchInterval } from "@/hooks/agentOptionsDiscovery";

export interface BotControlsEntry {
  controls: SessionControls;
  sessions: SessionInfo[];
}

async function loadBotControls(channelId: string, botId: string): Promise<BotControlsEntry> {
  const [controls, { sessions }] = await Promise.all([
    getSessionControls(channelId, botId),
    listChannelBotSessions(channelId, botId),
  ]);
  return { controls, sessions };
}

export function botControlsQuery(channelId: string, botId: string) {
  return {
    queryKey: queryKeys.botSessionControls(channelId, botId),
    queryFn: () => loadBotControls(channelId, botId),
    ...agentOptionsQueryPolicy,
  };
}

/** Invalidation also refreshes any mounted model/config controls. */
export function bustBotControls(channelId: string, botId: string): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.botSessionControls(channelId, botId) });
}

export function bustAllBotControls(botId: string): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.botControls(botId) });
}

export function useBotControls(channelId: string, botId: string | null, selectedSessionId: string) {
  const queryKey = queryKeys.botSessionControls(channelId, botId ?? "");
  const initialUpdates = useRef({ key: JSON.stringify(queryKey), count: queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0 });
  if (initialUpdates.current.key !== JSON.stringify(queryKey)) initialUpdates.current = { key: JSON.stringify(queryKey), count: queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0 };
  const query = useQuery({
    ...botControlsQuery(channelId, botId ?? ""),
    enabled: Boolean(botId),
    refetchInterval: (entry) => discoveryRefetchInterval(entry.state.dataUpdateCount, entry.state.fetchFailureCount, !!entry.state.data && entry.state.data.controls.config_options.length === 0, initialUpdates.current.count),
  }, queryClient);
  const previousSession = useRef(selectedSessionId);
  const { refetch } = query;
  useEffect(() => {
    if (previousSession.current === selectedSessionId) return;
    previousSession.current = selectedSessionId;
    if (botId) void refetch();
  }, [selectedSessionId, botId, refetch]);
  return { data: query.data, loading: query.isFetching, error: query.error, refresh: () => { if (botId) void refetch(); } };
}

/** A pinned target must never silently become a different session. */
export function resolveTargetSession(sessions: SessionInfo[], selectedSessionId: string) {
  return selectedSessionId
    ? sessions.find((session) => session.session_id === selectedSessionId)
    : sessions.find((session) => session.is_primary) ?? sessions[0];
}

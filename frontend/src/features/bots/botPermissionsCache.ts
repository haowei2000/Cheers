import { getBotPermissions } from "@/api/bots";
import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient, queryKeys } from "@/lib/queryClient";
import { agentOptionsQueryPolicy, discoveryRefetchInterval } from "@/hooks/agentOptionsDiscovery";

export function useBotPermissions(botId: string) {
  const queryKey = queryKeys.botPermissions(botId);
  const initialUpdates = useRef({ botId, count: queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0 });
  if (initialUpdates.current.botId !== botId) initialUpdates.current = { botId, count: queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0 };
  const query = useQuery({
    queryKey,
    queryFn: () => getBotPermissions(botId),
    ...agentOptionsQueryPolicy,
    refetchInterval: (entry) => discoveryRefetchInterval(entry.state.dataUpdateCount, entry.state.fetchFailureCount, !!entry.state.data && entry.state.data.config_options.advertised.length === 0, initialUpdates.current.count),
  }, queryClient);
  return { data: query.data, loading: query.isFetching, error: query.error, refresh: () => { void query.refetch(); } };
}


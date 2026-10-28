/** Six polite retries over about 90 seconds; opening/focusing also refreshes. */
const discoveryDelays = [3_000, 5_000, 10_000, 15_000, 25_000, 30_000];

export function discoveryRefetchInterval(
  dataUpdateCount: number,
  failureCount: number,
  optionsPending: boolean,
  initialUpdateCount = 0,
): number | false {
  if (!optionsPending || failureCount > 0) return false;
  return discoveryDelays[Math.max(0, dataUpdateCount - initialUpdateCount - 1)] ?? false;
}

export const agentOptionsQueryPolicy = {
  staleTime: 15_000,
  retry: false,
  refetchOnMount: "always",
  refetchOnWindowFocus: "always",
  refetchIntervalInBackground: false,
} as const;

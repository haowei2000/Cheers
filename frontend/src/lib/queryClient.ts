import { QueryClient } from "@tanstack/react-query";

/** Stable keys for REST-backed server state. Realtime chat state stays outside this cache. */
export const queryKeys = {
  currentUser: ["account", "me"] as const,
  externalIdentities: ["account", "external-identities"] as const,
  authSessions: ["account", "sessions"] as const,
  aiConsents: ["account", "ai-consents"] as const,
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 60_000,
    },
  },
});

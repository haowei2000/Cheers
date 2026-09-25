import { create } from "zustand";
import type { User } from "@/types";
import { apiBase, getServerBase, isTauri } from "@/lib/serverConfig";
import { invokeDesktop } from "@/lib/desktop";
import { clearClientSessionData } from "@/lib/clientSession";
import { queryClient } from "@/lib/queryClient";

interface AuthState {
  user: User | null;
  token: string | null;
  initialized: boolean;
  /** The signed-in token was rejected by the server (401 / ws auth_err). While true,
   *  App renders the full-screen "Session expired" takeover (DESIGN tier L) instead
   *  of letting the user keep operating a dead session. Cleared on setAuth/logout. */
  sessionExpired: boolean;
  setAuth: (user: User, token: string) => void;
  /** Swap just the token (e.g. the fresh token returned after a password change). */
  setToken: (token: string) => void;
  markSessionExpired: () => void;
  logout: () => void;
  restoreSession: () => Promise<string | null>;
}

interface RefreshResponse {
  access_token?: string;
  user_id?: string;
  username?: string;
  display_name?: string | null;
  role?: string;
}

const WEB_REFRESH_LOCK = "cheers-auth-refresh";
const CONCURRENT_REFRESH_RETRY_MS = 100;
let webRefreshInFlight: Promise<RefreshResponse | null> | null = null;

async function requestWebRefresh(): Promise<RefreshResponse | null> {
  const send = () => fetch(`${apiBase()}/auth/refresh`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

  let response = await send();
  if (response.status === 409) {
    // A request already in flight rotated the shared cookie. Give its Set-Cookie
    // response a moment to land, then retry once with the current cookie.
    await new Promise((resolve) => globalThis.setTimeout(resolve, CONCURRENT_REFRESH_RETRY_MS));
    response = await send();
  }
  if (!response.ok) return null;
  return response.json() as Promise<RefreshResponse>;
}

function restoreWebSession(): Promise<RefreshResponse | null> {
  if (webRefreshInFlight) return webRefreshInFlight;

  const refresh = async () => {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request(WEB_REFRESH_LOCK, requestWebRefresh);
    }
    return requestWebRefresh();
  };
  webRefreshInFlight = refresh().finally(() => {
    webRefreshInFlight = null;
  });
  return webRefreshInFlight;
}

export const useAuthStore = create<AuthState>()((set) => ({
  user: null,
  token: null,
  initialized: false,
  sessionExpired: false,
  setAuth: (user, token) =>
    set({ user, token, sessionExpired: false }),
  setToken: (token) =>
    set({ token, sessionExpired: false }),
  markSessionExpired: () => set({ sessionExpired: true }),
  logout: () => {
    clearClientSessionData();
    queryClient.clear();
    set({ user: null, token: null, sessionExpired: false });
  },
  restoreSession: async (): Promise<string | null> => {
    try {
      if (isTauri()) {
        const serverBase = getServerBase();
        if (!serverBase) return null;
        const body = await invokeDesktop<{
          access_token?: string;
          user_id?: string;
          username?: string;
          display_name?: string | null;
          role?: string;
        } | null>("desktop_refresh_session", { serverBase }).catch(() => null);
        if (body?.access_token && body.user_id) {
          set({
            user: {
              user_id: body.user_id,
              username: body.username,
              display_name: body.display_name ?? null,
              role: body.role,
            },
            token: body.access_token,
            sessionExpired: false,
          });
          return body.access_token;
        }
        return null;
      }
      const body = await restoreWebSession();
      if (!body) return null;
      if (body.access_token && body.user_id) {
        set({
          user: {
            user_id: body.user_id,
            username: body.username,
            display_name: body.display_name ?? null,
            role: body.role,
          },
          token: body.access_token,
          sessionExpired: false,
        });
        return body.access_token;
      }
      return null;
    } finally {
      set({ initialized: true });
    }
  },
}));

// Role lives in the JWT (the server authorizes on the token's `role` claim), so it's the
// authoritative source — `user.role` may be missing on older persisted sessions. Decode
// the claim; prefer `user.role` when present.
function roleFromToken(token: string | null): string | undefined {
  try {
    return (JSON.parse(atob((token ?? "").split(".")[1] ?? "")) as { role?: string }).role;
  } catch {
    return undefined;
  }
}

export function useCurrentRole(): string | undefined {
  return useAuthStore((s) => s.user?.role ?? roleFromToken(s.token));
}

export function useIsAdmin(): boolean {
  const role = useCurrentRole();
  return role === "system_admin" || role === "admin";
}

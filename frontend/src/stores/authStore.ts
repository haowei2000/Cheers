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

async function requestWebRefresh(url: string): Promise<RefreshResponse | null> {
  const send = () => fetch(url, {
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

function restoreWebSession(url: string): Promise<RefreshResponse | null> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(WEB_REFRESH_LOCK, () => requestWebRefresh(url));
  }
  return requestWebRefresh(url);
}

interface RestoreIdentity {
  generation: number;
  token: string | null;
  userId: string | null;
  serverBase: string | null;
}

interface PendingRestore {
  identity: RestoreIdentity;
  promise: Promise<string | null>;
}

function sameIdentity(first: RestoreIdentity, second: RestoreIdentity): boolean {
  return first.generation === second.generation && first.token === second.token
    && first.userId === second.userId && first.serverBase === second.serverBase;
}

export const useAuthStore = create<AuthState>()((set, get) => {
  // Account/token changes supersede requests even when values later return to
  // the same strings. Profile edits do not invalidate credential recovery.
  let generation = 0;
  let pendingRestore: PendingRestore | null = null;
  const identity = (): RestoreIdentity => ({
    generation,
    token: get().token,
    userId: get().user?.user_id ?? null,
    serverBase: getServerBase(),
  });
  const setAuthenticatedUser = (user: User, token: string) => {
    if (get().user?.user_id !== user.user_id) {
      clearClientSessionData();
      queryClient.clear();
    }
    set({ user, token, initialized: true, sessionExpired: false });
  };

  return {
    user: null,
    token: null,
    initialized: false,
    sessionExpired: false,
    setAuth: (user, token) => {
      if (get().user?.user_id !== user.user_id || get().token !== token) generation++;
      setAuthenticatedUser(user, token);
    },
    setToken: (token) => {
      generation++;
      set({ token, initialized: true, sessionExpired: false });
    },
    markSessionExpired: () => set({ sessionExpired: true }),
    logout: () => {
      generation++;
      clearClientSessionData();
      queryClient.clear();
      set({ user: null, token: null, initialized: true, sessionExpired: false });
    },
    restoreSession: (): Promise<string | null> => {
      const started = identity();
      if (pendingRestore && sameIdentity(pendingRestore.identity, started)) {
        return pendingRestore.promise;
      }
      const refreshUrl = `${apiBase()}/auth/refresh`;
      const isCurrent = () => sameIdentity(started, identity());
      const restore = async (): Promise<string | null> => {
        try {
          let body: RefreshResponse | null;
          if (isTauri()) {
            if (!started.serverBase) return null;
            body = await invokeDesktop<RefreshResponse | null>("desktop_refresh_session", {
              serverBase: started.serverBase,
            }).catch(() => null);
          } else {
            body = await restoreWebSession(refreshUrl);
          }
          if (!isCurrent() || !body?.access_token || !body.user_id) return null;
          const currentUser = get().user;
          // Profile data may have been edited while credentials were refreshing.
          // Existing same-account fields stay current; auth owns the token/role.
          setAuthenticatedUser(currentUser?.user_id === body.user_id
            ? { ...currentUser, role: body.role }
            : {
              user_id: body.user_id,
              username: body.username,
              display_name: body.display_name ?? null,
              role: body.role,
            }, body.access_token);
          return body.access_token;
        } catch (error) {
          if (!isCurrent()) return null;
          throw error;
        } finally {
          // A successful restore initializes in setAuthenticatedUser. A stale
          // completion must not initialize or otherwise modify a newer session.
          if (isCurrent()) set({ initialized: true });
        }
      };
      const pending: PendingRestore = {
        identity: started,
        promise: restore().finally(() => {
          if (pendingRestore === pending) pendingRestore = null;
        }),
      };
      pendingRestore = pending;
      return pending.promise;
    },
  };
});

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

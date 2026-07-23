import { create } from "zustand";
import type { User } from "@/types";
import { apiBase } from "@/lib/serverConfig";

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
  restoreSession: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()((set) => ({
      user: null,
      token: null,
      initialized: false,
      sessionExpired: false,
      setAuth: (user, token) => set({ user, token, sessionExpired: false }),
      setToken: (token) => set({ token, sessionExpired: false }),
      markSessionExpired: () => set({ sessionExpired: true }),
      logout: () => set({ user: null, token: null, sessionExpired: false }),
      restoreSession: async () => {
        try {
          const response = await fetch(`${apiBase()}/auth/refresh`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          if (!response.ok) return;
          const body = (await response.json()) as {
            access_token?: string;
            user_id?: string;
            username?: string;
            display_name?: string | null;
            role?: string;
          };
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
          }
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

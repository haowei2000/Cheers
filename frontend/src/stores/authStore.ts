import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { User } from "@/types";

interface AuthState {
  user: User | null;
  token: string | null;
  setAuth: (user: User, token: string) => void;
  /** Swap just the token (e.g. the fresh token returned after a password change). */
  setToken: (token: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      setAuth: (user, token) => set({ user, token }),
      setToken: (token) => set({ token }),
      logout: () => set({ user: null, token: null }),
    }),
    { name: "auth" }
  )
);

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

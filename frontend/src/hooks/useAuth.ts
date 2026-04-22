import { useCallback, useState } from "react";
import type { CurrentUser } from "../types";
import { type AuthFetch, makeAuthFetch } from "../api/client";

const STORAGE_KEY = "currentUser";
const SESSION_TTL_MS = 86_400_000; // 24h

type StoredAuth = {
  user: Exclude<CurrentUser, null>;
  token: string;
  loginTime: number;
};

function readStorage(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<StoredAuth> & { loginTime?: number };
    if (!data.loginTime || Date.now() - data.loginTime >= SESSION_TTL_MS) return null;
    return data as StoredAuth;
  } catch {
    return null;
  }
}

function readUser(): CurrentUser {
  return readStorage()?.user ?? null;
}

function readToken(): string | null {
  const stored = readStorage();
  if (!stored) return null;
  return stored.token ?? stored.user?.user_id ?? null;
}

export interface UseAuthResult {
  currentUser: CurrentUser;
  authToken: string | null;
  currentUserId: string;
  authFetch: AuthFetch;
  setAuth: (user: Exclude<CurrentUser, null>, token: string) => void;
  setCurrentUser: (user: CurrentUser) => void;
  logout: () => void;
}

export function useAuth(devUserId: string): UseAuthResult {
  const [currentUser, setCurrentUserState] = useState<CurrentUser>(readUser);
  const [authToken, setAuthToken] = useState<string | null>(readToken);

  const authFetch = useCallback<AuthFetch>(
    (url, options) => makeAuthFetch(authToken)(url, options),
    [authToken],
  );

  const setAuth = useCallback(
    (user: Exclude<CurrentUser, null>, token: string) => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ user, token, loginTime: Date.now() }),
        );
      } catch {}
      setCurrentUserState(user);
      setAuthToken(token);
    },
    [],
  );

  const setCurrentUser = useCallback((user: CurrentUser) => {
    setCurrentUserState(user);
    if (!user) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      data.user = user;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {}
  }, []);

  const logout = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    setCurrentUserState(null);
    setAuthToken(null);
  }, []);

  const currentUserId = currentUser?.user_id || devUserId;

  return {
    currentUser,
    authToken,
    currentUserId,
    authFetch,
    setAuth,
    setCurrentUser,
    logout,
  };
}

const API_BASE =
  (import.meta as { env?: Record<string, string> }).env?.VITE_API_BASE_URL ??
  "/api/v1";

function getToken(): string | null {
  try {
    const raw = localStorage.getItem("auth");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { token?: string } };
    return parsed?.state?.token ?? null;
  } catch {
    return null;
  }
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

export async function apiFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...authHeaders(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  return res;
}

export async function apiJson<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function buildWsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsBase =
    (import.meta as { env?: Record<string, string> }).env?.VITE_WS_BASE_URL ??
    `${proto}//${location.host}`;
  return `${wsBase}${path}`;
}

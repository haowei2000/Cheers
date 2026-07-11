const API_BASE =
  (import.meta as { env?: Record<string, string> }).env?.VITE_API_BASE_URL ||
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

// An error from a failed API response. Carries the HTTP status so callers can
// branch on it, while `message` is already the clean, human sentence extracted
// from the gateway body (safe to render straight into a toast).
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// thiserror prepends a machine "kind" to gateway error strings (see
// server/src/errors.rs). Strip it so the toast reads as a plain sentence
// instead of "bad request: …".
const MACHINE_ERROR_PREFIXES = [
  "bad request:",
  "unauthorized:",
  "forbidden:",
  "conflict:",
  "payload too large:",
  "database error:",
  "internal error:",
  "not found:",
];

function humanizeDetail(raw: string): string {
  const msg = raw.trim();
  const lower = msg.toLowerCase();
  for (const prefix of MACHINE_ERROR_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return msg.slice(prefix.length).trim();
    }
  }
  return msg;
}

// Turn a failed Response into an ApiError with a clean message. The gateway
// returns 4xx/5xx bodies as JSON `{ "detail": "<kind>: <message>" }`; we pull
// out `detail`, drop the machine prefix, and never surface raw JSON or markup.
async function toApiError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  let detail = "";
  if (text) {
    try {
      const body = JSON.parse(text) as {
        detail?: unknown;
        message?: unknown;
      };
      const raw = body.detail ?? body.message;
      if (typeof raw === "string") detail = humanizeDetail(raw);
    } catch {
      // Body wasn't JSON (e.g. a proxy HTML error page) — only reuse it if it
      // looks like a short plain message, never dump markup at the user.
      const trimmed = text.trim();
      if (trimmed && !trimmed.startsWith("<") && trimmed.length <= 200) {
        detail = trimmed;
      }
    }
  }
  return new ApiError(detail || `Request failed (HTTP ${res.status})`, res.status);
}

export async function apiJson<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    throw await toApiError(res);
  }
  return res.json() as Promise<T>;
}

export function buildWsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsBase =
    (import.meta as { env?: Record<string, string> }).env?.VITE_WS_BASE_URL ||
    `${proto}//${location.host}`;
  return `${wsBase}${path}`;
}

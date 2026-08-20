import { useAuthStore } from "@/stores/authStore";
import { apiBase, wsBase } from "@/lib/serverConfig";

function getToken(): string | null {
  return useAuthStore.getState().token;
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

// Global session-expiry classifier: a 401 on any authenticated request means the
// token is dead — flip the auth store so App shows the full-screen "Session
// expired" takeover (with a sign-in exit), instead of stranding the user on a
// page that keeps failing. `/auth/*` is exempt: there a 401 is a credential
// error (wrong password, bad reset code), not an expired session.
function classifyAuthFailure(path: string, status: number): void {
  if (
    status !== 401 ||
    path.startsWith("/auth/") ||
    path === "/users/me/delete" ||
    path.startsWith("/users/me/external-identities/")
  ) {
    return;
  }
  const auth = useAuthStore.getState();
  if (auth.token) auth.markSessionExpired();
}

export async function apiFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  // Resolved per call, not at module load: the desktop shell can switch the
  // gateway at runtime (serverConfig), and the browser default is unchanged.
  const url = `${apiBase()}${path}`;
  const res = await fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      ...authHeaders(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  classifyAuthFailure(path, res.status);
  return res;
}

// An error from a failed API response. Carries the HTTP status so callers can
// branch on it, while `message` is already the clean, human sentence extracted
// from the gateway body (safe to render straight into a toast).
export class ApiError extends Error {
  status: number;
  code?: string;
  provider?: string;
  constructor(
    message: string,
    status: number,
    metadata?: { code?: string; provider?: string }
  ) {
    super(message);
    this.status = status;
    this.code = metadata?.code;
    this.provider = metadata?.provider;
  }
}

// Tauri commands reject with plain strings, while browser APIs normally throw
// Error objects. Preserve either form so native failures are not replaced by a
// generic message. Do not stringify arbitrary objects: they may contain raw
// response data that should not be shown to users.
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return fallback;
}

// thiserror prepends a machine "kind" to gateway error strings (see
// server/src/errors.rs). Strip it so the toast reads as a plain sentence
// instead of "bad request: …".
const MACHINE_ERROR_PREFIXES = [
  "bad request:",
  "unauthorized:",
  "forbidden:",
  "conflict:",
  "precondition required:",
  "payload too large:",
  "database error:",
  "internal error:",
  "service unavailable:",
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
  let code: string | undefined;
  let provider: string | undefined;
  if (text) {
    try {
      const body = JSON.parse(text) as {
        detail?: unknown;
        message?: unknown;
        code?: unknown;
        provider?: unknown;
      };
      const raw = body.detail ?? body.message;
      if (typeof raw === "string") detail = humanizeDetail(raw);
      if (typeof body.code === "string") code = body.code;
      if (typeof body.provider === "string") provider = body.provider;
    } catch {
      // Body wasn't JSON (e.g. a proxy HTML error page) — only reuse it if it
      // looks like a short plain message, never dump markup at the user.
      const trimmed = text.trim();
      if (trimmed && !trimmed.startsWith("<") && trimmed.length <= 200) {
        detail = trimmed;
      }
    }
  }
  // Older gateways answered unique violations with a bare "conflict".
  if (res.status === 409 && (!detail || detail.toLowerCase() === "conflict")) {
    detail = "That name is already taken — choose another, or use Existing bot";
  }
  return new ApiError(detail || `Request failed (HTTP ${res.status})`, res.status, {
    code,
    provider,
  });
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
  return `${wsBase()}${path}`;
}

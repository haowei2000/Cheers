export const API_BASE = "/api/v1";

const WS_PROTO = location.protocol === "https:" ? "wss" : "ws";
export const WS_BASE = `${WS_PROTO}://${location.host}`;

export class ApiError extends Error {
  status: number;
  body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export function getAuthToken(): string | null {
  try {
    const stored = localStorage.getItem("currentUser");
    if (!stored) return null;
    const data = JSON.parse(stored);
    if (data.loginTime && Date.now() - data.loginTime < 86400000) {
      return data.token ?? data.user?.user_id ?? null;
    }
  } catch {}
  return null;
}

export interface RequestOptions extends Omit<RequestInit, "body" | "headers"> {
  body?: unknown;
  headers?: Record<string, string>;
  auth?: boolean;
  token?: string | null;
}

function resolveUrl(path: string): string {
  if (/^(https?:)?\/\//.test(path)) return path;
  // 已显式带 /api 前缀的保持不变；其他 path（包括 "/channels"、"channels" 都看作
  // API 子路径）统一拼到 API_BASE 上，避免 fetch 落到 SPA 的 try_files 兜底返
  // index.html 把 JSON.parse 撑崩。
  if (path.startsWith("/api")) return path;
  const suffix = path.startsWith("/") ? path.slice(1) : path;
  return `${API_BASE}/${suffix}`;
}

export async function apiFetch(path: string, options: RequestOptions = {}): Promise<Response> {
  const { body, headers = {}, auth = true, token, ...rest } = options;
  const url = resolveUrl(path);

  const finalHeaders: Record<string, string> = { ...headers };
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  if (body !== undefined && !isFormData && !finalHeaders["Content-Type"]) {
    finalHeaders["Content-Type"] = "application/json";
  }
  if (auth) {
    const authToken = token !== undefined ? token : getAuthToken();
    if (authToken && !finalHeaders["Authorization"]) {
      finalHeaders["Authorization"] = `Bearer ${authToken}`;
    }
  }

  const finalBody: BodyInit | undefined =
    body === undefined
      ? undefined
      : isFormData || typeof body === "string"
        ? (body as BodyInit)
        : JSON.stringify(body);

  return fetch(url, { ...rest, headers: finalHeaders, body: finalBody });
}

export async function apiJson<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const res = await apiFetch(path, options);
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "message" in data && typeof (data as { message?: unknown }).message === "string"
        ? (data as { message: string }).message
        : `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

export function buildWsUrl(path: string): string {
  const prefix = path.startsWith("/") ? "" : "/";
  return `${WS_BASE}${prefix}${path}`;
}

export type AuthFetch = (url: string, options?: RequestInit) => Promise<Response>;

export function makeAuthFetch(token: string | null): AuthFetch {
  return (url, options = {}) =>
    fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers as Record<string, string> | undefined),
      },
    });
}

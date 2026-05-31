import { DEFAULT_LANGUAGE, LANGUAGE_STORAGE_KEY, normalizeLanguage, type AppLanguage } from "../i18n/catalog";

const configuredApiBase = import.meta.env.VITE_API_BASE_URL?.trim();
export const API_BASE = configuredApiBase ? configuredApiBase : "/api/v1";

const configuredWsBase = import.meta.env.VITE_WS_BASE_URL?.trim();
const wsProto = location.protocol === "https:" ? "wss" : "ws";
export const WS_BASE = configuredWsBase
  ? configuredWsBase
  : `${wsProto}://${location.host}`;

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

export function getAppLanguage(): AppLanguage {
  try {
    return normalizeLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export function appLanguageHeaders(): Record<string, string> {
  const language = getAppLanguage();
  return {
    "Accept-Language": language,
    "X-AgentNexus-Language": language,
  };
}

export interface RequestOptions extends Omit<RequestInit, "body" | "headers"> {
  body?: unknown;
  headers?: Record<string, string>;
  auth?: boolean;
  token?: string | null;
}

function resolveUrl(path: string): string {
  if (/^(https?:)?\/\//.test(path)) return path;
  // Keep paths that already include /api. Treat all other paths, including
  // "/channels" and "channels", as API subpaths and prepend API_BASE so fetch
  // does not hit the SPA try_files fallback and receive index.html.
  if (path.startsWith("/api")) return path;
  const normalizedBase = API_BASE.endsWith("/") ? API_BASE.slice(0, -1) : API_BASE;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${suffix}`;
}

export async function apiFetch(path: string, options: RequestOptions = {}): Promise<Response> {
  const { body, headers = {}, auth = true, token, ...rest } = options;
  const url = resolveUrl(path);

  const finalHeaders: Record<string, string> = { ...appLanguageHeaders(), ...headers };
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
        ...appLanguageHeaders(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers as Record<string, string> | undefined),
      },
    });
}

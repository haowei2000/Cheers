import { apiJson } from "./client";
import { getServerBase, isTauri } from "@/lib/serverConfig";
import { invokeDesktop } from "@/lib/desktop";

export interface LoginResponse {
  status?: "authenticated" | "factor_required";
  transaction_id?: string;
  allowed_factors?: string[];
  expires_in?: number;
  requires_2fa: boolean;
  two_factor_session_id?: string;
  access_token?: string;
  token_type?: string;
  user_id?: string;
  username?: string;
  display_name?: string | null;
  role?: string;
  /** Native/desktop only — persist and re-present to skip 2FA on trusted devices. */
  trusted_device?: string;
}

export async function login(credentials: {
  login: string;
  password: string;
  client?: "web" | "ios" | "macos";
  device_name?: string;
}): Promise<LoginResponse> {
  if (isTauri()) {
    const serverBase = getServerBase();
    if (!serverBase) throw new Error("Choose a Cheers server first");
    return invokeDesktop<LoginResponse>("desktop_password_login", {
      serverBase,
      login: credentials.login,
      password: credentials.password,
    });
  }
  return apiJson<LoginResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify(credentials),
  });
}

export interface TwoFactorVerifyRequest {
  transaction_id: string;
  code: string;
  remember_device?: boolean;
}

export async function verifyTwoFactorLogin(
  body: TwoFactorVerifyRequest
): Promise<LoginResponse> {
  if (isTauri()) {
    const serverBase = getServerBase();
    if (!serverBase) throw new Error("Choose a Cheers server first");
    return invokeDesktop<LoginResponse>("desktop_verify_factor", {
      serverBase,
      transactionId: body.transaction_id,
      code: body.code,
      rememberDevice: body.remember_device ?? true,
    });
  }
  return apiJson<LoginResponse>("/auth/2fa/login", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function sendTwoFactorEmail(transactionId: string): Promise<{
  ok: boolean;
  email_hint?: string;
}> {
  return apiJson("/auth/2fa/email/send", {
    method: "POST",
    body: JSON.stringify({ transaction_id: transactionId }),
  });
}

export interface AuthCapabilities {
  client: "web" | "ios" | "macos";
  providers: { password: boolean; apple: boolean; google: boolean };
  self_service_registration: boolean;
  passkey?: boolean;
  passkey_rp_id?: string | null;
}

export async function getAuthCapabilities(): Promise<AuthCapabilities> {
  const client = isTauri() ? "macos" : "web";
  return apiJson<AuthCapabilities>(`/auth/capabilities?client=${client}`);
}

// ─── TOTP 2FA management ───────────────────────────────────────────────────

export async function twoFactorStatus(): Promise<{ enabled: boolean }> {
  return apiJson("/auth/2fa/status");
}

export async function setupTwoFactor(): Promise<{
  secret: string;
  provisioning_uri: string;
}> {
  return apiJson("/auth/2fa/setup", { method: "POST", body: "{}" });
}

export async function enableTwoFactor(code: string): Promise<{ backup_codes: string[] }> {
  return apiJson("/auth/2fa/enable", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export async function disableTwoFactor(code: string): Promise<{ ok: boolean }> {
  return apiJson("/auth/2fa/disable", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

// ─── Passkeys ──────────────────────────────────────────────────────────────

export interface PasskeyCredential {
  credential_pk: string;
  credential_id: string;
  name: string;
  created_at: string;
  last_used_at?: string | null;
  backup_eligible?: boolean;
  backup_state?: boolean;
}

export async function passkeyRegisterOptions(name?: string): Promise<Record<string, unknown>> {
  return apiJson("/auth/passkey/register/options", {
    method: "POST",
    body: JSON.stringify({ name: name || undefined }),
  });
}

export async function passkeyRegisterFinish(
  transactionId: string,
  credential: Record<string, unknown>
): Promise<PasskeyCredential> {
  return apiJson("/auth/passkey/register/finish", {
    method: "POST",
    body: JSON.stringify({ transaction_id: transactionId, credential }),
  });
}

export async function listPasskeys(): Promise<PasskeyCredential[]> {
  return apiJson("/auth/passkey/credentials");
}

export async function deletePasskey(credentialPk: string): Promise<{ ok: boolean }> {
  return apiJson(`/auth/passkey/credentials/${encodeURIComponent(credentialPk)}`, {
    method: "DELETE",
  });
}

export async function passkeyFactorOptions(
  transactionId: string
): Promise<Record<string, unknown>> {
  return apiJson("/auth/2fa/passkey/options", {
    method: "POST",
    body: JSON.stringify({ transaction_id: transactionId }),
  });
}

export async function passkeyFactorVerify(input: {
  transaction_id: string;
  credential: Record<string, unknown>;
  remember_device?: boolean;
}): Promise<LoginResponse> {
  return apiJson("/auth/2fa/passkey/verify", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function startOAuth(provider: "apple" | "google"): Promise<void> {
  const client = isTauri() ? "macos" : "web";
  const response = await apiJson<{ authorization_url: string }>(
    `/auth/oauth/${provider}/start`,
    {
      method: "POST",
      body: JSON.stringify({ client, device_name: isTauri() ? "Mac" : undefined }),
    }
  );
  if (isTauri()) {
    await invokeDesktop("desktop_open_oauth_url", { url: response.authorization_url });
  } else {
    window.location.assign(response.authorization_url);
  }
}

export async function exchangeOAuthHandoff(code: string): Promise<LoginResponse> {
  if (isTauri()) {
    const serverBase = getServerBase();
    if (!serverBase) throw new Error("Choose a Cheers server first");
    return invokeDesktop<LoginResponse>("desktop_oauth_handoff", { serverBase, code });
  }
  return apiJson<LoginResponse>("/auth/oauth/handoff", {
    method: "POST",
    body: JSON.stringify({ code, client: "web" }),
  });
}

export interface ExternalIdentityStatus {
  provider: "apple" | "google";
  linked: boolean;
  display_name: string | null;
  email: string | null;
  has_password: boolean;
  can_unlink: boolean;
  recent_authentication: boolean;
}

export async function getExternalIdentity(
  provider: "apple" | "google"
): Promise<ExternalIdentityStatus> {
  return apiJson(`/users/me/external-identities/${provider}`);
}

export async function unlinkExternalIdentity(
  provider: "apple" | "google"
): Promise<{ provider: string; linked: false }> {
  return apiJson(`/users/me/external-identities/${provider}`, { method: "DELETE" });
}

export async function deleteAccount(input: {
  confirmation: string;
  current_password?: string;
}): Promise<{ deleted: true }> {
  return apiJson("/users/me/delete", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Request a one-time email verification code for self-service sign-up. Rejects an
 *  email that's already registered (409). A live invite-link token substitutes for
 *  open registration when the instance has sign-ups disabled. */
export async function requestRegisterCode(
  email: string,
  inviteToken?: string
): Promise<{ ok: boolean }> {
  return apiJson("/auth/register/request-code", {
    method: "POST",
    body: JSON.stringify({ email, invite_token: inviteToken }),
  });
}

/** Self-service sign-up. Requires the verification code from `requestRegisterCode`.
 *  Creates a `member` account and returns a token (auto-login). */
export async function register(input: {
  username: string;
  password: string;
  email: string;
  code: string;
  display_name?: string;
  /** Invite-link token — lets sign-up through when open registration is off. */
  invite_token?: string;
}): Promise<LoginResponse> {
  return apiJson<LoginResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Rotate the current user's password. Returns a fresh token (the server revokes
 *  every other session); swap it into the store so THIS session stays signed in. */
export async function changePassword(input: {
  current_password: string;
  new_password: string;
  two_factor_code?: string;
}): Promise<{ ok: boolean; access_token: string }> {
  return apiJson("/auth/change-password", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Server-side logout: revokes all of the user's tokens (this + other devices). */
export async function logout(): Promise<{ ok: boolean }> {
  if (isTauri()) {
    const serverBase = getServerBase();
    if (serverBase) {
      const { useAuthStore } = await import("@/stores/authStore");
      await invokeDesktop("desktop_logout_session", {
        serverBase,
        accessToken: useAuthStore.getState().token,
      });
    }
    return { ok: true };
  }
  return apiJson("/auth/logout", { method: "POST" });
}

/** Request a one-time password-reset code by email. Always resolves (never reveals
 *  whether the email exists). */
export async function forgotPassword(email: string): Promise<{ ok: boolean }> {
  return apiJson("/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

/** Consume a reset code and set a new password (revokes all existing sessions). */
export async function resetPassword(input: {
  email: string;
  code: string;
  new_password: string;
}): Promise<{ ok: boolean }> {
  return apiJson("/auth/reset-password", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

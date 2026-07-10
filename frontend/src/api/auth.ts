import { apiJson } from "./client";

export interface LoginResponse {
  access_token: string;
  token_type: string;
  user_id: string;
  display_name: string | null;
  role: string;
}

export async function login(credentials: {
  login: string;
  password: string;
}): Promise<LoginResponse> {
  return apiJson<LoginResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify(credentials),
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
}): Promise<{ ok: boolean; access_token: string }> {
  return apiJson("/auth/change-password", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Server-side logout: revokes all of the user's tokens (this + other devices). */
export async function logout(): Promise<{ ok: boolean }> {
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

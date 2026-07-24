/** Browser WebAuthn helpers for Cheers passkey register / assert. */

function b64urlToBuffer(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToB64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Prefer nested `publicKey`, else treat the whole payload as creation options. */
export function creationPublicKey(options: Record<string, unknown>): PublicKeyCredentialCreationOptions {
  const raw = asRecord(options.publicKey ?? options);
  const rp = asRecord(raw.rp);
  const user = asRecord(raw.user);
  const challenge = String(raw.challenge ?? "");
  const userId = String(user.id ?? "");
  if (!challenge || !userId) {
    throw new Error("Passkey registration options are incomplete");
  }
  const pubKeyCredParams = Array.isArray(raw.pubKeyCredParams)
    ? (raw.pubKeyCredParams as PublicKeyCredentialParameters[])
    : [{ type: "public-key" as const, alg: -7 }];
  const excludeCredentials = Array.isArray(raw.excludeCredentials)
    ? (raw.excludeCredentials as Array<Record<string, unknown>>).map((c) => ({
        type: "public-key" as const,
        id: b64urlToBuffer(String(c.id ?? "")),
        transports: c.transports as AuthenticatorTransport[] | undefined,
      }))
    : undefined;
  return {
    rp: {
      name: String(rp.name ?? "Cheers"),
      id: rp.id ? String(rp.id) : undefined,
    },
    user: {
      id: b64urlToBuffer(userId),
      name: String(user.name ?? "user"),
      displayName: String(user.displayName ?? user.name ?? "user"),
    },
    challenge: b64urlToBuffer(challenge),
    pubKeyCredParams,
    timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
    attestation: (raw.attestation as AttestationConveyancePreference | undefined) ?? "none",
    authenticatorSelection:
      raw.authenticatorSelection as AuthenticatorSelectionCriteria | undefined,
    excludeCredentials,
    extensions: raw.extensions as AuthenticationExtensionsClientInputs | undefined,
  };
}

export function assertionPublicKey(options: Record<string, unknown>): PublicKeyCredentialRequestOptions {
  const raw = asRecord(options.publicKey ?? options);
  const challenge = String(raw.challenge ?? "");
  if (!challenge) throw new Error("Passkey assertion options are incomplete");
  const allowCredentials = Array.isArray(raw.allowCredentials)
    ? (raw.allowCredentials as Array<Record<string, unknown>>).map((c) => ({
        type: "public-key" as const,
        id: b64urlToBuffer(String(c.id ?? "")),
        transports: c.transports as AuthenticatorTransport[] | undefined,
      }))
    : undefined;
  return {
    challenge: b64urlToBuffer(challenge),
    rpId: raw.rpId ? String(raw.rpId) : undefined,
    allowCredentials,
    timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
    userVerification:
      (raw.userVerification as UserVerificationRequirement | undefined) ?? "preferred",
    extensions: raw.extensions as AuthenticationExtensionsClientInputs | undefined,
  };
}

export function credentialToJSON(credential: PublicKeyCredential): Record<string, unknown> {
  const anyCred = credential as PublicKeyCredential & {
    toJSON?: () => Record<string, unknown>;
  };
  if (typeof anyCred.toJSON === "function") {
    return anyCred.toJSON();
  }
  const response = credential.response;
  if (response instanceof AuthenticatorAttestationResponse) {
    return {
      id: credential.id,
      rawId: bufferToB64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bufferToB64url(response.clientDataJSON),
        attestationObject: bufferToB64url(response.attestationObject),
        transports:
          typeof response.getTransports === "function" ? response.getTransports() : undefined,
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }
  if (response instanceof AuthenticatorAssertionResponse) {
    return {
      id: credential.id,
      rawId: bufferToB64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bufferToB64url(response.clientDataJSON),
        authenticatorData: bufferToB64url(response.authenticatorData),
        signature: bufferToB64url(response.signature),
        userHandle: response.userHandle ? bufferToB64url(response.userHandle) : null,
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }
  throw new Error("Unexpected WebAuthn credential response");
}

export async function createPasskey(
  options: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!window.PublicKeyCredential) {
    throw new Error("This browser doesn't support passkeys");
  }
  const credential = (await navigator.credentials.create({
    publicKey: creationPublicKey(options),
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey creation was cancelled");
  return credentialToJSON(credential);
}

export async function getPasskey(
  options: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!window.PublicKeyCredential) {
    throw new Error("This browser doesn't support passkeys");
  }
  const credential = (await navigator.credentials.get({
    publicKey: assertionPublicKey(options),
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey sign-in was cancelled");
  return credentialToJSON(credential);
}

export function passkeyTransactionId(options: Record<string, unknown>): string {
  const id = options.transaction_id;
  if (typeof id !== "string" || !id) {
    throw new Error("Passkey transaction_id is missing");
  }
  return id;
}

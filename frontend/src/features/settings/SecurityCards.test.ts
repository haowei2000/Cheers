import { describe, expect, it } from "vitest";
import { authenticatorQrDataUrl, twoFactorSummary } from "./SecurityCards";

describe("authenticator QR code", () => {
  it("encodes a TOTP provisioning URI locally as a PNG data URL", async () => {
    const dataUrl = await authenticatorQrDataUrl(
      "otpauth://totp/Cheers:user?secret=JBSWY3DPEHPK3PXP&issuer=Cheers"
    );

    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("rejects non-TOTP links", async () => {
    await expect(authenticatorQrDataUrl("https://example.com/secret"))
      .rejects.toThrow("Invalid authenticator provisioning URI");
  });
});

describe("two-step verification summary", () => {
  it("names a passkey as the protection, with no authenticator enrolled", () => {
    // The regression this covers: 2FA used to mean "TOTP enrolled", so a
    // passkey-only account read as unprotected.
    expect(twoFactorSummary({ totp: false, passkey: true, email: false, password: false }))
      .toBe("Using passkey");
  });

  it("lists every armed method, strongest first", () => {
    expect(twoFactorSummary({ totp: true, passkey: true, email: true, password: true }))
      .toBe("Using passkey, authenticator app, email code, password");
    expect(twoFactorSummary({ totp: false, passkey: false, email: true, password: false }))
      .toBe("Using email code");
  });

  it("offers the full choice when nothing is armed yet", () => {
    expect(twoFactorSummary({ totp: false, passkey: false, email: false, password: false }))
      .toBe("Use a passkey, an authenticator app, or an email code");
  });

  it("falls back to a neutral line before the status loads", () => {
    expect(twoFactorSummary(undefined))
      .toBe("Require another verification step when you sign in");
  });
});

describe("password as a second step", () => {
  it("is named in the summary when armed", () => {
    // Only valid behind an OAuth or passkey first step; the server refuses to
    // arm it otherwise, since a password cannot be both halves of a sign-in.
    expect(twoFactorSummary({ totp: false, passkey: false, email: false, password: true }))
      .toBe("Using password");
  });
});

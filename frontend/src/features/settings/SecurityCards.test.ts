import { describe, expect, it } from "vitest";
import { authenticatorQrDataUrl } from "./SecurityCards";

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

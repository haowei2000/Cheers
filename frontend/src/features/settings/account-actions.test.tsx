import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ChangePasswordAction,
  DeleteAccountAction,
  ForgotPasswordAction,
  SignOutAction,
} from "./AccountSettings";
import { PasskeyCard, TwoFactorCard } from "./SecurityCards";

describe("account action launchers", () => {
  it("keeps credential fields hidden until an action is opened", () => {
    const markup = [
      renderToStaticMarkup(<ChangePasswordAction onRotated={() => {}} />),
      renderToStaticMarkup(<ForgotPasswordAction />),
      renderToStaticMarkup(<TwoFactorCard />),
      renderToStaticMarkup(<DeleteAccountAction onDeleted={() => {}} />),
      renderToStaticMarkup(<SignOutAction onSignOut={async () => {}} />),
      renderToStaticMarkup(<PasskeyCard />),
    ].join("");

    expect(markup).toContain("Change password");
    expect(markup).toContain("Forgot password");
    expect(markup).toContain("2FA settings");
    expect(markup).toContain("Delete");
    expect(markup).toContain("Sign out");
    expect(markup).not.toContain("<input");
  });
});

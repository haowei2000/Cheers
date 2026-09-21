import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ChangePasswordAction,
  DeleteAccountAction,
  EmailAction,
  SignOutAction,
} from "./AccountSettings";
import { PasskeyCard, TwoFactorCard } from "./SecurityCards";

describe("account action launchers", () => {
  it("keeps credential fields hidden until an action is opened", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <EmailAction />
        <ChangePasswordAction onRotated={() => {}} />
        <TwoFactorCard />
        <DeleteAccountAction onDeleted={() => {}} />
        <SignOutAction onSignOut={async () => {}} />
        <PasskeyCard />
      </QueryClientProvider>
    );

    expect(markup).toContain("Email");
    expect(markup).toContain("Change password");
    expect(markup).toContain("Two-step verification");
    expect(markup).toContain("Delete");
    expect(markup).toContain("Sign out");
    expect(markup).not.toContain("<input");
  });

  it("renders 'Set password' when the user has no password configured", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["account", "me"], {
      user_id: "user-123",
      username: "alice",
      display_name: "Alice",
      email: "alice@example.com",
      has_password: false,
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <EmailAction />
        <ChangePasswordAction onRotated={() => {}} />
      </QueryClientProvider>
    );

    expect(markup).toContain("Set password");
    expect(markup).toContain("Add a password to sign in without an external provider");
    expect(markup).toContain("alice@example.com");
  });

  it("renders 'Password' and current email when user has password and email", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["account", "me"], {
      user_id: "user-123",
      username: "alice",
      display_name: "Alice",
      email: "alice@example.com",
      has_password: true,
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <EmailAction />
        <ChangePasswordAction onRotated={() => {}} />
      </QueryClientProvider>
    );

    expect(markup).toContain("Change password");
    expect(markup).toContain("Change your password and sign out other devices");
    expect(markup).toContain("alice@example.com");
  });
});

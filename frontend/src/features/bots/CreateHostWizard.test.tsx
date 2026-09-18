import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { HostPairing, PairingGuidance } from "@/api/bots";
import type { BotItem } from "@/types";

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@/lib/serverConfig", () => ({
  isTauri: () => true, // Simulate desktop so "This Mac" button shows!
  serverOrigin: () => "https://cheers.example.com",
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ title, description, children }: { title: string; description?: string; children: ReactNode }) => (
    <div className="rounded-md border border-border-subtle bg-panel p-6 shadow-xl max-w-2xl mx-auto my-8">
      <div className="mb-4">
        <h2 className="text-comfortable font-semibold text-content-primary">{title}</h2>
        {description && <p className="text-compact text-content-secondary mt-1">{description}</p>}
      </div>
      {children}
    </div>
  ),
}));

vi.mock("@/api/bots", () => ({
  listBots: vi.fn().mockResolvedValue([]),
  createBot: vi.fn().mockResolvedValue({}),
  mintHostPairing: vi.fn().mockResolvedValue({
    pairing_code: "cp_live_48392019",
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    live_pairings: 1,
  }),
  revokeHostPairing: vi.fn().mockResolvedValue({}),
  getConnectorDiscovery: vi.fn().mockResolvedValue({ configured: true }),
  getPairingGuidance: vi.fn().mockResolvedValue({
    pairing_code_placeholder: "{{PAIRING_CODE}}",
    prompt_template: "Please setup the Cheers connector for @helper-bot using pairing code {{PAIRING_CODE}}. Keep it running as a background service.",
  }),
  redeemHostPairing: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/api/auth", () => ({
  fetchCurrentUser: vi.fn().mockResolvedValue({ id: "u1" }),
}));

vi.mock("@/features/desktop/desktopPlatform", () => ({
  isTauri: vi.fn().mockReturnValue(true),
  invokeDesktop: vi.fn(),
}));

import { CreateHostWizard } from "./CreateHostWizard";

function getDistCss(): string {
  try {
    const assetsDir = path.resolve(__dirname, "../../../dist/assets");
    const cssFile = fs.readdirSync(assetsDir).find((f) => f.startsWith("index-") && f.endsWith(".css"));
    return cssFile ? path.join(assetsDir, cssFile) : "";
  } catch {
    return "";
  }
}

const mockBot: BotItem = {
  bot_id: "bot-123",
  username: "helper-bot",
  display_name: "Helper Bot",
  bridge_provider: "claude",
};

const mockPairing = {
  pairing_code: "cp_live_48392019",
  expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  live_pairings: 1,
  bot_id: "bot-123",
  host_id: "host-456",
} as unknown as HostPairing;

const mockGuidance = {
  install_url: "https://cheers.example.com/api/v1/install.sh",
  pairing_code_placeholder: "{{PAIRING_CODE}}",
  prompt_template: "Please setup the Cheers connector for @helper-bot using pairing code {{PAIRING_CODE}}. Keep it running as a background service.",
} as PairingGuidance;

describe("CreateHostWizard", () => {
  it("renders 2-step navigation indicator and step 0", () => {
    const markup = renderToStaticMarkup(
      <CreateHostWizard bots={[mockBot]} onDone={() => undefined} onClose={() => undefined} />,
    );

    expect(markup).toContain(">Bot &amp; agent<");
    expect(markup).toContain(">Install &amp; connect<");
    expect(markup).not.toContain("Choose method");
    expect(markup).not.toContain("Run installer");

    const cssPath = getDistCss();
    const htmlDark = `<!DOCTYPE html>
<html class="dark" data-theme="dark">
<head>
<meta charset="utf-8">
${cssPath ? `<link rel="stylesheet" href="${cssPath}">` : ""}
<style>
body { background: #121214; color: #f4f4f5; margin: 0; padding: 24px; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
</style>
</head>
<body>
${markup}
</body>
</html>`;
    fs.writeFileSync("/tmp/wizard-preview-step0-dark.html", htmlDark);
  });

  it("renders step 1 with unified installation cards when initialStep is 1", () => {
    const markup = renderToStaticMarkup(
      <CreateHostWizard
        bots={[mockBot]}
        initialBotId={mockBot.bot_id}
        initialStep={1}
        initialPairing={mockPairing}
        initialGuidance={mockGuidance}
        onDone={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(markup).toContain("Run in terminal");
    expect(markup).toContain("Ask an agent on the host");
    expect(markup).toContain("Recommended · Easiest");
    expect(markup).toContain('title="Copy command"');
    expect(markup).toContain('title="Copy prompt"');
    expect(markup).toContain("cp_live_48392019");

    const cssPath = getDistCss();
    const htmlDark = `<!DOCTYPE html>
<html class="dark" data-theme="dark">
<head>
<meta charset="utf-8">
${cssPath ? `<link rel="stylesheet" href="${cssPath}">` : ""}
<style>
body { background: #121214; color: #f4f4f5; margin: 0; padding: 24px; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
</style>
</head>
<body>
${markup}
</body>
</html>`;

    const htmlLight = `<!DOCTYPE html>
<html class="light" data-theme="light">
<head>
<meta charset="utf-8">
${cssPath ? `<link rel="stylesheet" href="${cssPath}">` : ""}
<style>
body { background: #faf8f4; color: #18181b; margin: 0; padding: 24px; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
</style>
</head>
<body>
${markup}
</body>
</html>`;

    fs.writeFileSync("/tmp/wizard-preview-dark.html", htmlDark);
    fs.writeFileSync("/tmp/wizard-preview-light.html", htmlLight);
  });
});

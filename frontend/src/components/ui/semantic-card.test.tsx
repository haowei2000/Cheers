import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetricCard } from "./metric-card";
import { SettingsCard, SettingsCardSection, SettingsSection } from "./settings-card";

describe("semantic cards", () => {
  it("composes a settings section from one shared surface", () => {
    const markup = renderToStaticMarkup(
      <SettingsSection title="Appearance">
        <SettingsCard title="Color theme" description="Follow the system theme.">
          <span>Theme selector</span>
        </SettingsCard>
      </SettingsSection>,
    );

    expect(markup).toContain("Appearance");
    expect(markup).toContain("Color theme");
    expect(markup).toContain("rounded-sm bg-panel");
  });

  it("maps metric meaning to a registered semantic tone", () => {
    const markup = renderToStaticMarkup(
      <MetricCard label="Waiting" value={3} tone="warning" />,
    );

    expect(markup).toContain("text-warning-300");
    expect(markup).toContain("text-section-label");
  });

  it("centralizes nested settings section anatomy", () => {
    const markup = renderToStaticMarkup(
      <SettingsCard title="Account">
        <SettingsCardSection title="Passkeys" description="Use your device lock.">
          <span>Passkey list</span>
        </SettingsCardSection>
      </SettingsCard>,
    );

    expect(markup).toContain("Passkeys");
    expect(markup).toContain("Use your device lock.");
    expect(markup).toContain("border-t border-zinc-600/70");
  });
});

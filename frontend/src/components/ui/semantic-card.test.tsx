import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetricCard } from "./metric-card";
import { SettingsCard, SettingsSection } from "./settings-card";

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
});

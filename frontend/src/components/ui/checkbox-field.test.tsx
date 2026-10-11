import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckboxField } from "./checkbox-field";

describe("CheckboxField", () => {
  it("keeps native checkbox semantics behind the shared visual", () => {
    const markup = renderToStaticMarkup(<CheckboxField label="Enable transcription" checked readOnly />);

    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('class="peer sr-only"');
    expect(markup).toContain("Enable transcription");
    const id = /id="([^"]+)"/.exec(markup)?.[1];
    expect(id).toBeTruthy();
    expect(markup).toContain(`for="${id}"`);
  });

  it("keeps errors visible and offers supplementary help separately", () => {
    const markup = renderToStaticMarkup(
      <CheckboxField label="Permission" hint="Applies after saving" error="Required" />,
    );

    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain("Applies after saving");
    expect(markup).toContain("More information");
  });

  it("registers the indeterminate visual state", () => {
    const markup = renderToStaticMarkup(<CheckboxField label="Select all" indeterminate />);

    expect(markup).toContain("peer-indeterminate");
    expect(markup).toContain("data-mixed");
  });
});

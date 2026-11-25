import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field } from "./field";
import { Input } from "./input";
import { Select } from "./select";
import { Textarea } from "./textarea";

describe("Field control associations", () => {
  it("labels nested shared controls without relying on placeholders", () => {
    for (const control of [<Input placeholder="Example" />, <Select><option>Example</option></Select>, <Textarea />]) {
      const markup = renderToStaticMarkup(<Field label="Provider"><div>{control}</div></Field>);
      const labelId = markup.match(/id="([^"]+)"[^>]*>Provider</)?.[1];
      expect(labelId).toBeTruthy();
      expect(markup).toContain(`aria-labelledby="${labelId}"`);
    }
  });
  it("retains distinct explicit names inside composite fields", () => {
    const markup = renderToStaticMarkup(<Field label="Status"><Input aria-label="Emoji" /><Input aria-label="Status text" /></Field>);
    expect(markup).toContain('aria-label="Emoji"');
    expect(markup).toContain('aria-label="Status text"');
    expect(markup).not.toContain("aria-labelledby");
  });
  it("connects validation and status to the field while preserving existing descriptions", () => {
    const markup = renderToStaticMarkup(<Field label="Endpoint" htmlFor="endpoint" status="Saved endpoint" error="Enter a URL"><Input aria-describedby="extra-hint" /></Field>);
    expect(markup).toContain('id="endpoint"');
    expect(markup).toContain('aria-invalid="true"');
    const description = markup.match(/aria-describedby="([^"]+)"/)?.[1] ?? "";
    expect(description.split(" ")).toHaveLength(3);
    expect(description).toContain("extra-hint");
    for (const id of description.split(" ").filter(id => id !== "extra-hint")) expect(markup).toContain(`id="${id}"`);
  });
});

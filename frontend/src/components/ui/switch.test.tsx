import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Switch } from "./switch";
import { ControlSizeProvider } from "./control-size";

describe("Switch", () => {
  it("is a real input with switch semantics, tied to its visible label", () => {
    const html = renderToStaticMarkup(<Switch label="Read receipts" defaultChecked />);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('role="switch"');
    expect(html).toContain("Read receipts");
    const id = /id="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`for="${id}"`);
  });

  it("spells the state out so it never rests on colour and position alone", () => {
    const html = renderToStaticMarkup(<Switch label="Dark appearance" stateText="On" />);
    expect(html).toContain("On");
    expect(html).toContain("text-content-muted");
  });

  it("moves the thumb from the track, since peer-checked cannot reach a descendant", () => {
    const html = renderToStaticMarkup(<Switch label="x" />);
    // The child selector survives into the markup HTML-escaped, so assert on
    // what actually ships rather than on the source spelling.
    expect(html).toContain("peer-checked:[&amp;&gt;span]:translate-x-4");
    expect(html).toContain("peer-checked:[&amp;&gt;span]:bg-content-on-light");
  });

  it("inherits the ambient control size", () => {
    const html = renderToStaticMarkup(
      <ControlSizeProvider size="comfortable">
        <Switch label="x" />
      </ControlSizeProvider>,
    );
    expect(html).toContain("min-h-11");
  });

  it("marks a disabled switch as unclickable rather than merely dim", () => {
    const html = renderToStaticMarkup(<Switch label="x" disabled />);
    expect(html).toContain("disabled");
    expect(html).toContain("cursor-not-allowed");
  });
});

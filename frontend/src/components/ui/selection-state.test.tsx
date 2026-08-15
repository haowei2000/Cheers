import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import { ControlTrigger } from "./control-trigger";

describe("shared control selection state", () => {
  it("gives toggle buttons shared styling and pressed semantics", () => {
    const markup = renderToStaticMarkup(
      <Button content="icon" selected aria-label="Open files">
        <span aria-hidden="true">F</span>
      </Button>,
    );

    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('data-selected="true"');
    expect(markup).toContain("bg-control");
  });

  it("uses selected tab semantics without mixing in toggle semantics", () => {
    const markup = renderToStaticMarkup(
      <Button role="tab" selected aria-selected="true">
        Overview
      </Button>,
    );

    expect(markup).toContain('role="tab"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).not.toContain("aria-pressed");
    expect(markup).toContain('data-selected="true"');
  });

  it("uses expanded semantics instead of pressed semantics for disclosures", () => {
    const markup = renderToStaticMarkup(
      <ControlTrigger selected aria-expanded="true">
        Members
      </ControlTrigger>,
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).not.toContain("aria-pressed");
    expect(markup).toContain('data-selected="true"');
  });
});

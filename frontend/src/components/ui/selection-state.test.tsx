import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import { ControlTrigger } from "./control-trigger";
import { ChoiceButton } from "./choice-button";
import { IconButton } from "./icon-button";
import { NavigationItem } from "./item";
import { MenuOption } from "./menu-option";
import { highlightedClasses, selectedLabelClasses } from "./selection";
import { TabOption } from "./tab-option";

describe("shared control selection state", () => {
  it("gives toggle buttons shared styling and pressed semantics", () => {
    const markup = renderToStaticMarkup(
      <Button content="icon" selected aria-label="Open files">
        <span aria-hidden="true">F</span>
      </Button>,
    );

    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('data-selected="true"');
    expect(markup).toContain("bg-selected");
    expect(markup).toContain("ring-selected-indicator/70");
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
    expect(markup).toContain("border-b-2");
    expect(markup).toContain("border-content-strong");
    expect(markup).not.toContain("ring-selected-indicator/70");
  });

  it("styles tab options with canonical epistolary underline", () => {
    const markup = renderToStaticMarkup(<TabOption label="Active" selected />);

    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('data-selected="true"');
    expect(markup).toContain("border-b-2");
    expect(markup).toContain("border-content-strong");
    expect(markup).not.toContain("ring-selected-indicator/70");
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

  it("does not mix pressed semantics into an expanded Button trigger", () => {
    const markup = renderToStaticMarkup(
      <Button selected aria-expanded="true">Model</Button>,
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).not.toContain("aria-pressed");
    expect(markup).toContain("bg-selected");
  });

  it("gives every selectable primitive the same surface and label", () => {
    const markups = [
      renderToStaticMarkup(<Button variant="plain" selected>Model</Button>),
      renderToStaticMarkup(<ControlTrigger selected>Members</ControlTrigger>),
      renderToStaticMarkup(<ChoiceButton label="Light" leading={<span />} selected />),
      renderToStaticMarkup(<MenuOption label="Files" selected />),
      renderToStaticMarkup(<IconButton label="Split" selected><span /></IconButton>),
      renderToStaticMarkup(<NavigationItem title="general" selected onClick={() => undefined} />),
    ];
    for (const markup of markups) {
      expect(markup).toContain("bg-selected");
      expect(markup).toContain("hover:bg-selected-hover");
      for (const token of selectedLabelClasses.split(" ")) expect(markup).toContain(token);
      expect(markup).not.toContain("shadow-sm");
    }
  });

  it("keeps a selected IconButton from reapplying its resting tone", () => {
    const markup = renderToStaticMarkup(<IconButton label="Split" selected><span /></IconButton>);
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).not.toContain("hover:bg-control-hover");
  });

  it("styles a keyboard highlight as hover, not as selection", () => {
    const markup = renderToStaticMarkup(<MenuOption label="Files" highlighted />);
    expect(markup).toContain(highlightedClasses);
    expect(markup).not.toContain("bg-selected");
  });

  it("gives vertical tabs the row rail instead of an underline", () => {
    const markup = renderToStaticMarkup(
      <Button role="tab" tabOrientation="vertical" selected aria-selected="true">
        main.rs
      </Button>,
    );
    expect(markup).toContain("border-l-2");
    expect(markup).toContain("border-l-selected-indicator");
    expect(markup).toContain("bg-selected");
    expect(markup).not.toContain("border-b-2");
    expect(markup).not.toContain("aria-pressed");
  });
});

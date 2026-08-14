import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import { actionLabels } from "./action-labels";
import { Input } from "./input";
import { Select } from "./select";

describe("shared control geometry", () => {
  it("maps icon, text, and icon+text buttons to the three registered widths", () => {
    const short = renderToStaticMarkup(<Button>OK</Button>);
    const long = renderToStaticMarkup(<Button>A much longer action label</Button>);
    const iconText = renderToStaticMarkup(<Button content="iconText"><span aria-hidden>+</span>Add</Button>);
    const icon = renderToStaticMarkup(<Button content="icon" aria-label="Add"><span aria-hidden>+</span></Button>);

    expect(short).toContain("w-24");
    expect(long).toContain("w-24");
    expect(iconText).toContain("w-32");
    expect(iconText).toContain('data-button-slot="icon"');
    expect(iconText).toContain('data-button-slot="label"');
    expect(iconText).toContain("h-9 w-9");
    expect(iconText).toContain("px-3");
    expect(iconText).toContain("gap-0");
    expect(icon).toContain("h-9 w-9");
    expect(short).toContain("text-regular");
    expect(iconText).toContain("text-regular");
    expect(icon).toContain("text-regular");
  });

  it("requires an explicit fill mode for container-width actions", () => {
    const markup = renderToStaticMarkup(<Button controlWidth="fill">Continue</Button>);
    expect(markup).toContain("w-full");
    expect(markup).not.toContain("w-24");
  });

  it("renders ActionKey labels and keeps every Latin label within the iconText slot budget", () => {
    const markup = renderToStaticMarkup(
      <Button content="iconText" action="create" aria-label="Create a new discussion"><span aria-hidden>+</span></Button>,
    );
    expect(markup).toContain("Create");
    expect(markup).toContain('data-button-slot="label"');
    expect(markup).not.toContain('data-button-slot="label" class="inline-flex min-w-0 flex-1 items-center justify-center self-stretch px-3">New discussion');
    for (const label of Object.values(actionLabels)) {
      expect(label.split(/\s+/)).toHaveLength(label.includes(" ") ? 2 : 1);
      expect(label.length).toBeLessThanOrEqual(8);
    }
  });

  it("keeps a specific text label when an action key is also provided", () => {
    const markup = renderToStaticMarkup(
      <Button action="setup">Add installation</Button>,
    );
    expect(markup).toContain("Add installation");
    expect(markup).not.toContain(">Set up<");
  });

  it("owns leading-icon field padding inside the Input primitive", () => {
    const markup = renderToStaticMarkup(<Input inset="leading" aria-label="Search" />);
    expect(markup).toContain("px-3");
    expect(markup).toContain("pl-9");
  });

  it("keeps toolbar selects in the shared medium-width slot", () => {
    const markup = renderToStaticMarkup(
      <Select controlWidth="slot" aria-label="Workspace"><option>Personal</option></Select>,
    );
    expect(markup).toContain("w-32");
    expect(markup).toContain("h-9");
    expect(markup).toContain("text-regular");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChoiceGroup } from "./choice-button";

const options = [
  { value: "public", label: "Public", leading: <span>#</span> },
  { value: "private", label: "Private", leading: <span>lock</span> },
] as const;

describe("ChoiceGroup", () => {
  it("renders one iconText radio group with a single tab stop", () => {
    const markup = renderToStaticMarkup(
      <ChoiceGroup
        ariaLabel="Channel visibility"
        value="public"
        options={options}
        onChange={() => undefined}
      />,
    );

    expect(markup).toContain('role="radiogroup"');
    expect(markup.match(/role="radio"/g)).toHaveLength(2);
    expect(markup.match(/data-button-content="iconText"/g)).toHaveLength(2);
    expect(markup.match(/data-control-width="fill"/g)).toHaveLength(2);
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('aria-checked="false"');
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(1);
    expect(markup.match(/data-button-slot="icon"/g)).toHaveLength(2);
    expect(markup.match(/data-button-slot="label"/g)).toHaveLength(2);
  });

  it("removes disabled groups from the keyboard order", () => {
    const markup = renderToStaticMarkup(
      <ChoiceGroup
        ariaLabel="Channel visibility"
        value="public"
        options={options}
        onChange={() => undefined}
        disabled
      />,
    );

    expect(markup).toContain('aria-disabled="true"');
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup).not.toContain('tabindex="0"');
  });
});

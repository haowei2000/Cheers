import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DropdownSelect } from "./dropdown-select";

describe("DropdownSelect", () => {
  it("uses the shared selector trigger instead of a native select", () => {
    const markup = renderToStaticMarkup(
      <DropdownSelect
        label="Add scene"
        ariaLabel="Add scene"
        options={[{ value: "research", label: "Research lab" }]}
        onSelect={() => undefined}
      />,
    );

    expect(markup).toContain("data-control-trigger");
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).not.toContain("<select");
  });
});

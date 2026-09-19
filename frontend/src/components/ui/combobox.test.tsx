import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Combobox, filterComboboxOptions, nextComboboxIndex } from "./combobox";

const options = [
  { value: "ada", label: "Ada Lovelace", searchText: "analytical engine" },
  { value: "grace", label: "Grace Hopper", disabled: true },
  { value: "margaret", label: "Margaret Hamilton" },
];

describe("Combobox", () => {
  it("renders the complete ARIA input contract", () => {
    const markup = renderToStaticMarkup(
      <Combobox value="ada" options={options} onValueChange={() => undefined} ariaLabel="Choose an engineer" />,
    );
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('aria-autocomplete="list"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Choose an engineer"');
    expect(markup).toContain('value="Ada Lovelace"');
  });

  it("filters labels, values, and registered aliases", () => {
    expect(filterComboboxOptions(options, "engine").map((option) => option.value)).toEqual(["ada"]);
    expect(filterComboboxOptions(options, "margaret").map((option) => option.value)).toEqual(["margaret"]);
  });

  it("skips disabled options during keyboard movement", () => {
    expect(nextComboboxIndex(options, 0, 1)).toBe(2);
    expect(nextComboboxIndex(options, 2, -1)).toBe(0);
    expect(nextComboboxIndex(options, -1, "last")).toBe(2);
  });
});

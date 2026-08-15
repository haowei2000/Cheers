import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Hash } from "lucide-react";
import { InputWithLeadingIcon } from "./input-with-leading-icon";
import { SearchInput } from "./search-input";

describe("leading-icon inputs", () => {
  it("keeps the icon inside the shared Input boundary", () => {
    const markup = renderToStaticMarkup(
      <InputWithLeadingIcon
        leading={<Hash />}
        aria-label="Channel name"
        placeholder="Channel name…"
      />,
    );

    expect(markup).toContain('data-input-composite="leading-icon"');
    expect(markup).toContain('data-input-slot="leading"');
    expect(markup).toContain("pl-9");
    expect(markup).toContain("ring-inset");
    expect(markup.match(/focus:ring-2/g)).toHaveLength(1);
    expect(markup).not.toContain("focus-within:ring-2");
  });

  it("renders search as an accessible semantic input", () => {
    const markup = renderToStaticMarkup(
      <SearchInput aria-label="Search channels" placeholder="Search channels…" />,
    );

    expect(markup).toContain('type="search"');
    expect(markup).toContain('aria-label="Search channels"');
    expect(markup).toContain('data-input-slot="leading"');
    expect(markup).toContain("h-4 w-4");
  });
});

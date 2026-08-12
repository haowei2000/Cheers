import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import { Input } from "./input";

describe("shared control geometry", () => {
  it("keeps peer text buttons in the registered slot regardless of label length", () => {
    const short = renderToStaticMarkup(<Button>OK</Button>);
    const long = renderToStaticMarkup(<Button>A much longer action label</Button>);

    expect(short).toContain("w-24");
    expect(long).toContain("w-24");
    expect(long).toContain("overflow-hidden");
  });

  it("requires an explicit fill mode for container-width actions", () => {
    const markup = renderToStaticMarkup(<Button controlWidth="fill">Continue</Button>);
    expect(markup).toContain("w-full");
    expect(markup).not.toContain("w-24");
  });

  it("owns leading-icon field padding inside the Input primitive", () => {
    const markup = renderToStaticMarkup(<Input inset="leading" aria-label="Search" />);
    expect(markup).toContain("px-3");
    expect(markup).toContain("pl-9");
  });
});

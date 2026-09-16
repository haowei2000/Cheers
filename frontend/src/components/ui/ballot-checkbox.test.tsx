import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BallotCheckbox } from "./ballot-checkbox";

describe("BallotCheckbox", () => {
  it("renders unchecked state with neutral boundary and transparent check", () => {
    const markup = renderToStaticMarkup(<BallotCheckbox checked={false} />);
    expect(markup).toContain("bg-control/40");
    expect(markup).toContain("ring-zinc-700/60");
    expect(markup).not.toContain("lucide-check");
  });

  it("renders checked state with carbon-ink accent and check icon", () => {
    const markup = renderToStaticMarkup(<BallotCheckbox checked={true} />);
    expect(markup).toContain("bg-accent-600");
    expect(markup).toContain("text-content-on-accent");
    expect(markup).toContain("lucide-check");
  });

  it("supports compact sizing", () => {
    const markup = renderToStaticMarkup(<BallotCheckbox checked={true} size="compact" />);
    expect(markup).toContain("w-3.5 h-3.5");
  });
});

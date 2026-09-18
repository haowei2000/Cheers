import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Lock } from "lucide-react";
import { LockOff, SlashedIcon, withSlash, SLASH_PATH } from "./slashed-icon";

describe("slashed-icon", () => {
  it("renders LockOff with standard top-left to bottom-right diagonal slash", () => {
    const markup = renderToStaticMarkup(<LockOff className="h-4 w-4" />);
    expect(markup).toContain('class="lucide lucide-lock-off lucide-LockOff h-4 w-4"');
    expect(markup).toContain(`<path d="${SLASH_PATH}">`);
    // Includes lock body and shackle
    expect(markup).toContain("<rect");
  });

  it("renders SlashedIcon with diagonal slash when slashed is true", () => {
    const markup = renderToStaticMarkup(<SlashedIcon icon={Lock} slashed={true} className="h-4 w-4" />);
    expect(markup).toContain(`<path d="${SLASH_PATH}"`);
    expect(markup).toContain("<rect");
  });

  it("renders clean icon when slashed is false", () => {
    const markup = renderToStaticMarkup(<SlashedIcon icon={Lock} slashed={false} className="h-4 w-4" />);
    expect(markup).not.toContain(SLASH_PATH);
    expect(markup).toContain("<rect");
  });

  it("withSlash produces a slashed icon component", () => {
    const SlashedLock = withSlash(Lock);
    const markup = renderToStaticMarkup(<SlashedLock className="h-4 w-4" />);
    expect(markup).toContain(`<path d="${SLASH_PATH}"`);
    expect(markup).toContain("<rect");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WindowChromeProvider } from "./WindowChromeContext";
import { RouteChromeHeader } from "./RouteChromeHeader";

describe("RouteChromeHeader", () => {
  it("keeps the route header inline outside the desktop titlebar", () => {
    const markup = renderToStaticMarkup(
      <WindowChromeProvider placement="inline">
        <RouteChromeHeader actions={<button>Refresh</button>}>
          <header><h1>Fleet</h1><button>Refresh</button></header>
        </RouteChromeHeader>
      </WindowChromeProvider>,
    );

    expect(markup).toContain("<header>");
    expect(markup).toContain("Fleet");
    expect(markup).toContain("Refresh");
  });

  it("removes the duplicate inline header in desktop window chrome shells", () => {
    const markup = renderToStaticMarkup(
      <WindowChromeProvider placement="window">
        <RouteChromeHeader actions={<button>Refresh</button>}>
          <header><h1>Fleet</h1></header>
        </RouteChromeHeader>
      </WindowChromeProvider>,
    );

    expect(markup).toBe("");
  });
});

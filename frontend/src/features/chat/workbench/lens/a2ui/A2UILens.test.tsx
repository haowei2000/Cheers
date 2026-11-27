import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { A2UILens } from "./A2UILens";
import example from "./example.a2ui.json";

describe("official @a2ui/react A2UILens", () => {
  it("renders standard A2UI basicCatalog custom elements via A2uiSurface", () => {
    const html = renderToStaticMarkup(<A2UILens data={example} config={undefined} onChange={() => {}} />);
    expect(html).toContain('aria-label="Interactive surface report"');
    expect(html).toContain("a2ui-column");
    expect(html).toContain("a2ui-text");
    expect(html).toContain("a2ui-textfield");
    expect(html).toContain("a2ui-checkbox");
    expect(html).toContain("a2ui-button");
    expect(html).not.toContain("<iframe");
  });

  it("reports malformed input and does not inject script tags", () => {
    const html = renderToStaticMarkup(<A2UILens data={{}} config={undefined} onChange={() => {}} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Open Raw");

    const doc = JSON.parse(JSON.stringify(example));
    doc.messages[0].createSurface.components[1].text = "<script>alert(1)</script>";
    const safe = renderToStaticMarkup(<A2UILens data={doc} config={undefined} onChange={() => {}} />);
    expect(safe).toContain("a2ui-text");
    expect(safe).not.toContain("<script>");
  });
});

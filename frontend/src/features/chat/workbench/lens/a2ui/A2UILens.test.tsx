import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { A2UILens } from "./A2UILens";
import example from "./example.a2ui.json";

describe("native A2UI lens", () => {
  it("renders labelled shared controls and disables actions without a host", () => {
    const html = renderToStaticMarkup(<A2UILens data={example} config={undefined} onChange={() => {}} />);
    expect(html).toContain("Prepare a report");
    expect(html).toContain("Report topic");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Resource-oriented UI");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).not.toContain("<iframe");
  });
  it("reports malformed input and displays source text safely", () => {
    const html = renderToStaticMarkup(<A2UILens data={{}} config={undefined} onChange={() => {}} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Open Raw");
    const doc = JSON.parse(JSON.stringify(example));
    doc.messages[1].updateComponents.components[1].text = "<script>alert(1)</script>";
    const safe = renderToStaticMarkup(<A2UILens data={doc} config={undefined} onChange={() => {}} />);
    expect(safe).toContain("&lt;script&gt;");
    expect(safe).not.toContain("<script>");
  });
});

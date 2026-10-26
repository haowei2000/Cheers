import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SectionNav } from "./section-nav";

const Icon = () => <svg />;
const items = [
  { id: "profile", label: "Profile", icon: Icon },
  { id: "account", label: "Account", icon: Icon, badge: <span>2</span> },
] as const;

describe("SectionNav", () => {
  it("renders a desktop rail and a phone tab row, both as page navigation", () => {
    const markup = renderToStaticMarkup(
      <SectionNav ariaLabel="Settings sections" items={items} selected="account" onSelect={() => {}} />,
    );
    // One current entry per presentation; neither claims tab semantics.
    expect(markup.match(/aria-current="page"/g)).toHaveLength(2);
    expect(markup).not.toContain('role="tab"');
    // Desktop rail hides on phones; phone row hides from sm up.
    expect(markup).toContain("max-sm:hidden");
    expect(markup).toContain("sm:hidden");
    // Phone row uses the shared underline, not the row rail.
    expect(markup).toContain("border-b-2");
    expect(markup).toContain("border-content-strong");
  });
});

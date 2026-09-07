import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Plus } from "lucide-react";
import { ButtonGroup } from "./button-group";
import { ActionButton } from "./action-button";
import { ChoiceGroup } from "./choice-button";
import { Button } from "./button";

describe("ButtonGroup", () => {
  it("preserves mixed control semantics and supplies the shared size", () => {
    const html = renderToStaticMarkup(
      <ButtonGroup label="Panel controls" controlSize="compact" floating>
        <ActionButton action="add" context="toolbar" />
        <ChoiceGroup ariaLabel="View" value="plan" onChange={() => {}} options={[{ value: "plan", label: "Plan", leading: <Plus /> }]} />
        <Button role="switch" aria-checked={true} content="icon" aria-label="Live updates"><Plus /></Button>
      </ButtonGroup>,
    );
    expect(html).toContain('role="group" aria-label="Panel controls"');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html.match(/data-control-size="compact"/g)).toHaveLength(3);
    expect(html).not.toContain("overflow-hidden rounded-concentric");
    expect(html).toContain("flex-wrap");
  });
});

import { describe, expect, it, vi } from "vitest";
import { createReplyViewHost, createWorkbenchViewHost } from "./resourceViewHost";
import { createInteractionDispatcher } from "./interaction";

describe("ResourceViewHost", () => {
  it("enforces readOnly and disables canDesignEdit in reply views", () => {
    const requestInteraction = vi.fn().mockResolvedValue({ msg_id: "m1" });
    const interactions = createInteractionDispatcher({ requestInteraction });

    const host = createReplyViewHost({
      uri: "cheers:desk/forms/test.a2ui.json",
      version: 1,
      expanded: false,
      interactions,
    });

    expect(host.presentation).toBe("minimal");
    expect(host.capabilities.canDesignEdit).toBe(false);
    expect(host.capabilities.interactions).toContain("request");
    expect(host.readOnly).toBe(false);

    const expandedHost = createReplyViewHost({
      uri: "cheers:desk/forms/test.a2ui.json",
      version: 1,
      expanded: true,
      interactions,
    });
    expect(expandedHost.presentation).toBe("medium");
    expect(expandedHost.capabilities.canDesignEdit).toBe(false);
  });

  it("allows design editing in Workbench when writable and active", () => {
    const interactions = createInteractionDispatcher({});

    const host = createWorkbenchViewHost({
      uri: "cheers:desk/cards/test.tsx",
      version: 2,
      interactions,
      inspectorActive: true,
      readOnly: false,
    });

    expect(host.presentation).toBe("max");
    expect(host.capabilities.canDesignEdit).toBe(true);
    expect(host.readOnly).toBe(false);

    const readOnlyHost = createWorkbenchViewHost({
      uri: "cheers:desk/cards/test.tsx",
      version: 2,
      interactions,
      inspectorActive: true,
      readOnly: true,
    });
    expect(readOnlyHost.capabilities.canDesignEdit).toBe(false);
    expect(readOnlyHost.readOnly).toBe(true);
  });
});

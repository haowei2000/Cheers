import { describe, expect, it } from "vitest";
import {
  artifactCsp,
  createReplyViewHost,
  createWorkbenchViewHost,
  extractTsxActions,
} from "@cheers/canvas-runtime";

describe("@cheers/canvas-runtime package integration", () => {
  it("generates strict Content Security Policy without external connect or eval", () => {
    const csp = artifactCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("navigate-to 'none'");
  });

  it("extracts TSX action declarations from JSDoc comments", () => {
    const tsx = `/**
 * @cheers-actions
 * [
 *   {
 *     "actionId": "vote.submit",
 *     "name": "cheers.request",
 *     "botId": "11111111-2222-3333-4444-555555555555",
 *     "payload": { "option": "A" },
 *     "presentation": ["minimal", "medium"],
 *     "version": 1
 *   }
 * ]
 */
export default function Poll() { return <div>Poll</div>; }`;

    const actions = extractTsxActions(tsx);
    expect(actions).toHaveLength(1);
    expect(actions[0].actionId).toBe("vote.submit");
    expect(actions[0].name).toBe("cheers.request");
    expect(actions[0].botId).toBe("11111111-2222-3333-4444-555555555555");
    expect(actions[0].presentation).toEqual(["minimal", "medium"]);
  });

  it("creates reply view host with minimal presentation and locked design editing", () => {
    const host = createReplyViewHost({
      uri: "cheers:desk/polls/sample.tsx",
      version: 2,
      expanded: false,
      interactions: Object.assign(async () => ({ ok: true as const, outcome: "requested" as const }), {
        capabilities: ["request"] as const,
      }),
    });

    expect(host.presentation).toBe("minimal");
    expect(host.capabilities.canDesignEdit).toBe(false);
    expect(host.capabilities.canWrite).toBe(true);
    expect(host.readOnly).toBe(false);
  });

  it("creates workbench view host with max presentation and inspector capability", () => {
    const host = createWorkbenchViewHost({
      uri: "cheers:desk/polls/sample.tsx",
      version: 2,
      inspectorActive: true,
      interactions: Object.assign(async () => ({ ok: true as const, outcome: "requested" as const }), {
        capabilities: ["request"] as const,
      }),
    });

    expect(host.presentation).toBe("max");
    expect(host.capabilities.canDesignEdit).toBe(true);
    expect(host.capabilities.canWrite).toBe(true);
    expect(host.readOnly).toBe(false);
  });
});

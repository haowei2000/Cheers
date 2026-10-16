import { describe, expect, it } from "vitest";
import { extractTsxActions } from "./artifactActions";

describe("extractTsxActions", () => {
  it("extracts declared actions from JSDoc comments with asterisks", () => {
    const source = `
/**
 * @cheers-actions
 * [
 *   {
 *     "actionId": "report.prepare",
 *     "name": "cheers.request",
 *     "botId": "11111111-2222-3333-4444-555555555555",
 *     "payload": { "topic": null, "count": 5 },
 *     "presentation": ["minimal", "medium"]
 *   }
 * ]
 */
import React from "react";
export default function Card() { return <div>Card</div>; }
`;
    const actions = extractTsxActions(source);
    expect(actions).toHaveLength(1);
    expect(actions[0].actionId).toBe("report.prepare");
    expect(actions[0].name).toBe("cheers.request");
    expect(actions[0].botId).toBe("11111111-2222-3333-4444-555555555555");
    expect(actions[0].payload).toEqual({ topic: null, count: 5 });
    expect(actions[0].presentation).toEqual(["minimal", "medium"]);
  });

  it("handles plain block comments and object envelopes", () => {
    const source = `
/* @cheers-actions
{
  "actions": [
    {
      "actionId": "submit_order",
      "type": "request",
      "botId": "22222222-3333-4444-5555-666666666666",
      "payload": { "orderId": "123" }
    }
  ]
}
*/
export default function Order() {}
`;
    const actions = extractTsxActions(source);
    expect(actions).toHaveLength(1);
    expect(actions[0].actionId).toBe("submit_order");
    expect(actions[0].name).toBe("cheers.request");
    expect(actions[0].botId).toBe("22222222-3333-4444-5555-666666666666");
    expect(actions[0].payload).toEqual({ orderId: "123" });
    expect(actions[0].presentation).toEqual(["minimal", "medium", "max"]);
  });

  it("returns empty array when no @cheers-actions marker or invalid format", () => {
    expect(extractTsxActions("export default function App() {}")).toEqual([]);
    expect(extractTsxActions("// @cheers-actions not-json")).toEqual([]);
    expect(extractTsxActions("/* @cheers-actions { invalid json } */")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { findSessionReference } from "./sessionReference";

const ID = "01a1422e-d5e6-7e10-be3b-040fa49834a4";

describe("findSessionReference", () => {
  it("finds a Codex thread link inside a draft", () => {
    expect(findSessionReference(`continue codex://threads/${ID} please`)).toEqual({
      raw: `codex://threads/${ID}`,
      app: "Codex thread",
    });
  });

  it("finds resume commands copied from a terminal", () => {
    expect(findSessionReference(`codex resume ${ID}`)?.app).toBe("Codex thread");
    expect(findSessionReference(`claude --resume ${ID}`)?.app).toBe("Claude Code session");
    expect(findSessionReference(`claude -r ${ID}`)?.raw).toBe(`claude -r ${ID}`);
  });

  it("ignores ordinary text and bare ids", () => {
    expect(findSessionReference("let's discuss codex threads")).toBeNull();
    expect(findSessionReference(ID)).toBeNull();
    expect(findSessionReference("codex://threads/not-an-id")).toBeNull();
  });
});

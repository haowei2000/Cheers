import { describe, expect, it } from "vitest";
import { filterCollaborators, merge3Way } from "./collab";
import type { PresenceFocus } from "../hooks/useChatRealtime";

describe("collab 3-way merge", () => {
  it("merges when only local changed", () => {
    const base = "line 1\nline 2\nline 3";
    const local = "line 1\nline 2 edited\nline 3";
    const remote = "line 1\nline 2\nline 3";
    const res = merge3Way(base, local, remote);
    expect(res.hasConflict).toBe(false);
    expect(res.merged).toBe("line 1\nline 2 edited\nline 3");
  });

  it("merges when only remote changed", () => {
    const base = "line 1\nline 2\nline 3";
    const local = "line 1\nline 2\nline 3";
    const remote = "line 1\nline 2 remote\nline 3";
    const res = merge3Way(base, local, remote);
    expect(res.hasConflict).toBe(false);
    expect(res.merged).toBe("line 1\nline 2 remote\nline 3");
  });

  it("smoothly merges non-overlapping concurrent changes", () => {
    const base = "line 1\nline 2\nline 3\nline 4";
    const local = "line 1 (user edited)\nline 2\nline 3\nline 4";
    const remote = "line 1\nline 2\nline 3\nline 4 (bot edited)";
    const res = merge3Way(base, local, remote);
    expect(res.hasConflict).toBe(false);
    expect(res.merged).toBe("line 1 (user edited)\nline 2\nline 3\nline 4 (bot edited)");
  });

  it("inserts conflict markers when concurrent edits overlap", () => {
    const base = "line 1\nline 2\nline 3";
    const local = "line 1\nline 2 local\nline 3";
    const remote = "line 1\nline 2 remote\nline 3";
    const res = merge3Way(base, local, remote);
    expect(res.hasConflict).toBe(true);
    expect(res.conflictsCount).toBe(1);
    expect(res.merged).toContain("<<<<<<< LOCAL (Your edit)");
    expect(res.merged).toContain("line 2 local");
    expect(res.merged).toContain("=======");
    expect(res.merged).toContain("line 2 remote");
    expect(res.merged).toContain(">>>>>>> REMOTE (Incoming edit)");
  });

  it("handles identical concurrent changes cleanly without conflict", () => {
    const base = "line 1\nline 2\nline 3";
    const local = "line 1\nline 2 updated\nline 3";
    const remote = "line 1\nline 2 updated\nline 3";
    const res = merge3Way(base, local, remote);
    expect(res.hasConflict).toBe(false);
    expect(res.merged).toBe("line 1\nline 2 updated\nline 3");
  });
});

describe("filterCollaborators", () => {
  it("filters presence items matching current file path", () => {
    const items: PresenceFocus[] = [
      { user_id: "u1", bot_id: "b1", path: "main.tsx" },
      { user_id: "u2", bot_id: "b1", path: "other.md" },
      { user_id: "u3", bot_id: "b1", path: "main.tsx" },
    ];
    const collabs = filterCollaborators(items, "main.tsx", "u1");
    expect(collabs).toHaveLength(2);
    expect(collabs[0].isSelf).toBe(true);
    expect(collabs[0].name).toBe("You");
    expect(collabs[1].isSelf).toBe(false);
    expect(collabs[1].name).toBe("User u3");
  });

  it("returns empty when no path is provided", () => {
    expect(filterCollaborators([], null)).toEqual([]);
  });
});

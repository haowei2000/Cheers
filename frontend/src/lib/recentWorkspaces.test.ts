import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addRecentWorkspace,
  formatWorkspaceDisplayPath,
  getRecentWorkspaces,
  removeRecentWorkspace,
  workspaceNameFromPath,
} from "./recentWorkspaces";

describe("recentWorkspaces", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      length: 0,
      key: () => null,
    };
    vi.stubGlobal("window", {
      localStorage: storage,
      dispatchEvent: vi.fn(),
    });
  });

  it("extracts workspace name from path", () => {
    expect(workspaceNameFromPath("/Users/haowei/Projects/Cheers")).toBe("Cheers");
    expect(workspaceNameFromPath("/home/ubuntu/repo/")).toBe("repo");
    expect(workspaceNameFromPath("")).toBe("/");
  });

  it("formats display path nicely", () => {
    expect(formatWorkspaceDisplayPath("/Users/haowei/Projects/Cheers")).toBe("~/Projects/Cheers");
    expect(formatWorkspaceDisplayPath("/home/ubuntu/repo")).toBe("~/repo");
    expect(formatWorkspaceDisplayPath("/var/www/site")).toBe("/var/www/site");
  });

  it("adds, sorts by recency, and removes workspaces", () => {
    expect(getRecentWorkspaces()).toEqual([]);

    addRecentWorkspace("/Users/haowei/Projects/Cheers", "bot-1");
    addRecentWorkspace("/Users/haowei/Projects/Frontend", "bot-2");

    const recents = getRecentWorkspaces();
    expect(recents).toHaveLength(2);
    expect(recents[0].name).toBe("Frontend");
    expect(recents[0].path).toBe("/Users/haowei/Projects/Frontend");
    expect(recents[0].botId).toBe("bot-2");

    expect(recents[1].name).toBe("Cheers");

    // Re-adding Cheers bumps it to the top
    addRecentWorkspace("/Users/haowei/Projects/Cheers", "bot-1");
    const updated = getRecentWorkspaces();
    expect(updated[0].name).toBe("Cheers");

    // Remove
    removeRecentWorkspace("/Users/haowei/Projects/Cheers");
    expect(getRecentWorkspaces()).toHaveLength(1);
    expect(getRecentWorkspaces()[0].name).toBe("Frontend");
  });
});

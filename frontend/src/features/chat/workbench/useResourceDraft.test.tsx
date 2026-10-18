import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ResourceDraftFeedback, type useResourceDraft } from "./useResourceDraft";
import type { DraftState } from "./resourceDraft";

function feedback(status: DraftState["status"]) {
  const draft: ReturnType<typeof useResourceDraft> = {
    enabled: true, data: {}, setData: vi.fn(),
    state: { data: {}, revision: 1, dirty: false, loaded: true, status,
      error: status === "conflict" ? "Another device changed this draft." : undefined },
    refresh: vi.fn(), keepLocal: vi.fn(), useRemote: vi.fn(),
  };
  return renderToStaticMarkup(<ResourceDraftFeedback draft={draft} />);
}

describe("resource draft feedback", () => {
  it("keeps routine loading and successful sync quiet", () => {
    expect(feedback("loading")).toBe("");
    expect(feedback("synced")).toBe("");
  });
  it("retains actionable offline and conflict feedback", () => {
    const offline = feedback("offline");
    expect(offline).toContain("Reconnect to sync.");
    expect(offline).toContain("Reload the cloud draft");
    const conflict = feedback("conflict");
    expect(conflict).toContain('role="alert"');
    expect(conflict).toContain("Another device changed this draft.");
    expect(conflict).toContain("Keep my local draft");
    expect(conflict).toContain("Use the cloud draft");
  });
});

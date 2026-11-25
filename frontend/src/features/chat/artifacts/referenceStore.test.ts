import { describe, expect, it, vi } from "vitest";
import type { Artifact, ArtifactContent } from "./client";
import { createArtifactReferenceStore, HEAD_CHARS } from "./referenceStore";

const id = "0f8b6c2e-4d3a-4b1c-9e7f-2a5d8c1b3e60";
function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    artifact_id: id, channel_id: "c1", uri: `cheers:artifact/${id}`, title: "roadmap.md",
    source_kind: "text", source_id: "f1", path: "dev/roadmap.md", content_type: "text/markdown",
    size_bytes: 10, version: 1, source_version: 1, availability: "ready",
    created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z", expires_at: null,
    ...overrides,
  };
}
function client(current: () => Artifact, text = "# Roadmap\n") {
  return {
    get: vi.fn(async () => current()),
    read: vi.fn(async (): Promise<ArtifactContent> => ({ artifact: current(), content: text, kind: "text", truncated: false })),
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("artifact reference store", () => {
  it("fetches a referenced artifact once for every subscriber", async () => {
    const api = client(() => artifact());
    const store = createArtifactReferenceStore(api);
    store.subscribe(id, () => {});
    store.subscribe(id, () => {});
    await settle();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(store.snapshot(id)).toMatchObject({ artifact: { title: "roadmap.md" }, head: "# Roadmap\n", loading: false });
  });

  it("publishes the title before the source arrives", async () => {
    const api = client(() => artifact());
    let release = () => {};
    api.read.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ artifact: artifact(), content: "late", kind: "text", truncated: false });
    }));
    const store = createArtifactReferenceStore(api);
    store.subscribe(id, () => {});
    await settle();
    expect(store.snapshot(id)).toMatchObject({ artifact: { title: "roadmap.md" }, loading: true });
    expect(store.snapshot(id).head).toBeUndefined();
    release();
    await settle();
    expect(store.snapshot(id).head).toBe("late");
  });

  it("does not read attachments or unavailable artifacts", async () => {
    const api = client(() => artifact({ source_kind: "attachment" }));
    const store = createArtifactReferenceStore(api);
    store.subscribe(id, () => {});
    await settle();
    expect(api.read).not.toHaveBeenCalled();
    expect(store.snapshot(id).loading).toBe(false);
  });

  it("keeps only the head of a large source", async () => {
    const store = createArtifactReferenceStore(client(() => artifact(), "x".repeat(HEAD_CHARS * 2)));
    store.subscribe(id, () => {});
    await settle();
    expect(store.snapshot(id).head).toHaveLength(HEAD_CHARS);
  });

  it("retries a failed lookup instead of caching it as missing", async () => {
    const api = client(() => artifact());
    api.get.mockRejectedValueOnce(new Error("DISCONNECTED"));
    const store = createArtifactReferenceStore(api);
    const stop = store.subscribe(id, () => {});
    await settle();
    expect(store.snapshot(id)).toEqual({ missing: true, loading: false });
    stop();
    store.subscribe(id, () => {});
    await settle();
    expect(store.snapshot(id).artifact?.title).toBe("roadmap.md");
  });

  it("keeps the last answer when a refresh fails", async () => {
    const api = client(() => artifact());
    const store = createArtifactReferenceStore(api);
    store.subscribe(id, () => {});
    store.invalidate(1);
    await settle();
    api.get.mockRejectedValueOnce(new Error("DISCONNECTED"));
    store.invalidate(2);
    await settle();
    expect(store.snapshot(id)).toMatchObject({ artifact: { title: "roadmap.md" }, head: "# Roadmap\n" });
    expect(store.snapshot(id).missing).toBeUndefined();
  });

  it("shows a rename and a deletion after the files change", async () => {
    let current = artifact();
    const api = client(() => current);
    const store = createArtifactReferenceStore(api);
    store.subscribe(id, () => {});
    store.invalidate(1);
    await settle();
    current = artifact({ title: "q4.md", version: 2 });
    store.invalidate(2);
    await settle();
    expect(store.snapshot(id).artifact?.title).toBe("q4.md");
    current = artifact({ availability: "deleted", version: 3 });
    store.invalidate(3);
    await settle();
    expect(store.snapshot(id)).toMatchObject({ artifact: { availability: "deleted" }, loading: false });
    expect(store.snapshot(id).head).toBeUndefined();
  });

  it("does not re-read the source when only the tick changed", async () => {
    const api = client(() => artifact());
    const store = createArtifactReferenceStore(api);
    store.subscribe(id, () => {});
    store.invalidate(1);
    await settle();
    store.invalidate(1);
    store.invalidate(2);
    await settle();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.read).toHaveBeenCalledTimes(1);
  });

  it("leaves references nobody is showing alone until they are shown again", async () => {
    const api = client(() => artifact());
    const store = createArtifactReferenceStore(api);
    const stop = store.subscribe(id, () => {});
    store.invalidate(1);
    await settle();
    stop();
    store.invalidate(2);
    await settle();
    expect(api.get).toHaveBeenCalledTimes(1);
    store.subscribe(id, () => {});
    await settle();
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});

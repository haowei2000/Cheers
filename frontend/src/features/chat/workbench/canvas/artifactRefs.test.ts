import { describe, expect, it } from "vitest";
import type { Artifact } from "../../artifacts/client";
import { artifactExcerpt, artifactNodeDetail, artifactNodeTitle } from "./artifactRefs";
import { parseCanvas } from "./document";

const id = "0f8b6c2e-4d3a-4b1c-9e7f-2a5d8c1b3e60";
const node = parseCanvas({ canvas: 1, nodes: [{ id: "plan", source: { kind: "artifact", id } }] })!.nodes[0];

function artifact(overrides: Partial<Artifact>): Artifact {
  return {
    artifact_id: id, channel_id: "c1", uri: `cheers:artifact/${id}`, title: "roadmap.canvas.yaml",
    source_kind: "text", source_id: "f1", path: "dev/roadmap.canvas.yaml", content_type: "text/yaml",
    size_bytes: 10, version: 3, source_version: 3, availability: "ready",
    created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z", expires_at: null,
    ...overrides,
  };
}

const ref = (overrides: Partial<Artifact>) => ({ artifact: artifact(overrides), loading: false });
const missing = { missing: true, loading: false };

describe("artifact node labels", () => {
  it("shows the node id and artifact id until the catalog answers", () => {
    expect(artifactNodeTitle(node, undefined)).toBe("plan");
    expect(artifactNodeDetail(id, undefined)).toBe(id);
  });

  it("takes the title from the catalog, so a rename shows without editing the canvas", () => {
    expect(artifactNodeTitle(node, ref({ title: "q4-roadmap.canvas.yaml" }))).toBe("q4-roadmap.canvas.yaml");
    expect(artifactNodeDetail(id, ref({}))).toBe("Canvas");
  });

  it("says why an artifact cannot be opened", () => {
    expect(artifactNodeDetail(id, ref({ availability: "deleted" }))).toBe("Deleted");
    expect(artifactNodeDetail(id, ref({ availability: "expired" }))).toBe("Expired");
  });

  it("does not distinguish an unknown id from one the viewer may not read", () => {
    expect(artifactNodeTitle(node, missing)).toBe("plan");
    expect(artifactNodeDetail(id, missing)).toBe("Unavailable");
  });
});

describe("artifact excerpts", () => {
  it("keeps the opening lines and marks what it left out", () => {
    expect(artifactExcerpt("\n\n# Roadmap\n\n- ship\n")).toBe("# Roadmap\n\n- ship");
    expect(artifactExcerpt("1\n2\n3\n4\n5\n6\n7\n8")).toBe("1\n2\n3\n4\n5\n6\n…");
    expect(artifactExcerpt("1\n2\n3\n4\n5\n6\n")).toBe("1\n2\n3\n4\n5\n6");
  });

  it("cuts a long line instead of letting it fill the card", () => {
    const excerpt = artifactExcerpt("x".repeat(500));
    expect(excerpt).toHaveLength(161);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});

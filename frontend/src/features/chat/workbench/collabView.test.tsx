import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CollaboratorPills, ConflictBanner } from "./collabView";
import type { CollaboratorInfo } from "./collab";
import type { FileSessionConflict } from "./jsonFile";

describe("CollaboratorPills", () => {
  it("renders null when 0 or 1 collaborator is active", () => {
    const markup0 = renderToStaticMarkup(<CollaboratorPills collaborators={[]} />);
    expect(markup0).toBe("");

    const markup1 = renderToStaticMarkup(
      <CollaboratorPills
        collaborators={[{ id: "u1:null", name: "You", isBot: false, isSelf: true }]}
      />
    );
    expect(markup1).toBe("");
  });

  it("renders status pill when 2+ collaborators are active", () => {
    const collaborators: CollaboratorInfo[] = [
      { id: "u1:null", name: "You", isBot: false, isSelf: true },
      { id: "u2:null", name: "Alice", isBot: false, isSelf: false },
    ];
    const markup = renderToStaticMarkup(
      <CollaboratorPills collaborators={collaborators} />
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="2 collaborators editing"');
    expect(markup).toContain("2 editing");
  });
});

describe("ConflictBanner", () => {
  it("renders null when no conflict exists", () => {
    const markup = renderToStaticMarkup(
      <ConflictBanner conflict={null} onResolve={vi.fn()} />
    );
    expect(markup).toBe("");
  });

  it("renders accessible alert banner with resolution actions", () => {
    const conflict: FileSessionConflict = {
      baseText: "line 1\n",
      localText: "line 1 local\n",
      remoteText: "line 1 remote\n",
      conflictsCount: 1,
    };

    const markup = renderToStaticMarkup(
      <ConflictBanner conflict={conflict} onResolve={vi.fn()} />
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain("Collaboration Conflict");
    expect(markup).toContain("Keep Mine");
    expect(markup).toContain("Accept Incoming");
    expect(markup).toContain("Merge with Markers");
  });
});

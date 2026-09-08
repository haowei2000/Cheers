import { describe, expect, it, vi } from "vitest";
import type { FsClient, FileContent } from "@/features/chat/workbench/fsClient";
import type { SharedLayout } from "@/features/chat/workbench/sharedLayout";
import {
  buildLayoutUpdate,
  commitSharedLayout,
  layoutForChannel,
} from "./useChannelLayout";

const EMPTY: SharedLayout = { version: 1, panels: {} };

describe("channel-scoped shared layout", () => {
  it("does not expose channel A while channel B is still loading", () => {
    expect(
      layoutForChannel({ channelId: "A", layout: EMPTY }, "B", true),
    ).toBeUndefined();
    expect(
      layoutForChannel({ channelId: "A", layout: EMPTY }, "A", false),
    ).toBeUndefined();
  });

  it("keeps a delayed save on the client captured for its original channel", async () => {
    let finishRead!: (file: FileContent) => void;
    const readA = vi.fn(
      () => new Promise<FileContent>((resolve) => { finishRead = resolve; }),
    );
    const writeA = vi.fn(async () => ({ path: ".workbench.json", version: 2 }));
    const writeB = vi.fn(async () => ({ path: ".workbench.json", version: 2 }));
    const clientA = { read: readA, write: writeA } as Pick<FsClient, "read" | "write">;
    const clientB = {
      read: vi.fn(),
      write: writeB,
    } as unknown as Pick<FsClient, "read" | "write">;

    let currentClient = clientA;
    const saving = commitSharedLayout(currentClient, {
      version: 1,
      panels: { files: { open: true } },
    });
    currentClient = clientB;
    finishRead({
      path: ".workbench.json",
      content: JSON.stringify({ layout: EMPTY }),
      version: 1,
      is_dir: false,
    });

    await saving;
    expect(writeA).toHaveBeenCalledOnce();
    expect(writeB).not.toHaveBeenCalled();
    expect(currentClient).toBe(clientB);
  });

  it("preserves closed panel geometry and only docks a known-open panel", () => {
    const update = buildLayoutUpdate(
      { files: false, workspace: true, viewboard: false, workbench: false },
      undefined,
      {},
      { width: 1000, height: 800 },
    );
    expect(update.panels.files).toEqual({ open: false });
    expect(update.panels.workspace).toEqual({ open: true, rect: null });
  });
});

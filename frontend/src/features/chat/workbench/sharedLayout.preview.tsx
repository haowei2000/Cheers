import { createRoot, type Root } from "react-dom/client";
import { useCallback, useRef, useState } from "react";
import { LayoutGrid, Paperclip } from "lucide-react";
import { ContextActionsProvider } from "@/components/ui/context-actions";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { Button } from "@/components/ui/button";
import { LaneBoundsContext } from "@/hooks/laneBounds";
import { SharedLayoutContext } from "@/hooks/sharedLayout";
import { requestLayoutReset, toLaneRect, type SharedLayout } from "./sharedLayout";
import type { SpawnKind } from "./laneSnap";
import "@/index.css";

// Harness for the channel's shared window layout, with no gateway: the shared value is
// local state you can change from the buttons, standing in for a teammate's save or an
// agent writing `.workbench.json`.
//
// Run it: `npm run dev`, then open /dev/shared-layout.html.
//
// What it is here to show, none of which a pure test can reach:
//   1. A window with no local geometry ADOPTS the shared placement.
//   2. Changing the shared value moves a window that is still following.
//   3. Dragging a window makes it stop following — and a later shared change leaves it
//      exactly where its viewer put it.
//   4. "Reset" drops the override and the window rejoins mid-session.

const LEFT_HALF: SharedLayout = {
  version: 1,
  panels: {
    workbench: { rect: { x: 0, y: 0, w: 0.5, h: 1 }, open: true },
    files: { rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, open: true },
  },
};
const STACKED: SharedLayout = {
  version: 1,
  panels: {
    workbench: { rect: { x: 0, y: 0, w: 1, h: 0.5 }, open: true },
    files: { rect: { x: 0, y: 0.5, w: 1, h: 0.5 }, open: true },
  },
};

function Preview() {
  const [shared, setShared] = useState<SharedLayout>(LEFT_HALF);
  const laneRef = useRef<HTMLElement | null>(null);
  const getLaneBounds = useCallback(() => laneRef.current?.getBoundingClientRect() ?? null, []);
  const geomFor = useCallback(
    (kind: SpawnKind) => {
      const rect = shared.panels[kind]?.rect;
      const bounds = getLaneBounds();
      if (!rect || !bounds || bounds.width <= 0) return null;
      return toLaneRect(rect, bounds);
    },
    [shared, getLaneBounds]
  );

  return (
    <ContextActionsProvider>
      <main className="h-screen w-screen bg-canvas p-4 text-content-primary">
        <div className="mb-3 flex items-center gap-2">
          <Button variant="secondary" controlSize="regular" onClick={() => setShared(LEFT_HALF)}>
            Shared: side by side
          </Button>
          <Button variant="secondary" controlSize="regular" onClick={() => setShared(STACKED)}>
            Shared: stacked
          </Button>
          <Button variant="secondary" controlSize="regular" onClick={() => requestLayoutReset()}>
            Reset to channel layout
          </Button>
          <span className="text-compact text-content-secondary">
            Drag a window, then switch the shared layout: it should stay put until Reset.
          </span>
        </div>
        <section
          ref={(el) => {
            laneRef.current = el;
          }}
          className="relative h-[calc(100%-3rem)] w-full overflow-hidden rounded-sm border border-line-subtle"
        >
          <LaneBoundsContext.Provider value={getLaneBounds}>
            <SharedLayoutContext.Provider value={geomFor}>
              <FloatingPanel
                title="Workbench"
                icon={LayoutGrid}
                storageKey="cheers.float.workbench"
                spawnKind="workbench"
                onClose={() => undefined}
              >
                <div className="p-4 text-compact text-content-secondary">Workbench body</div>
              </FloatingPanel>
              <FloatingPanel
                title="Channel files"
                icon={Paperclip}
                storageKey="cheers.float.files"
                spawnKind="files"
                onClose={() => undefined}
              >
                <div className="p-4 text-compact text-content-secondary">Files body</div>
              </FloatingPanel>
            </SharedLayoutContext.Provider>
          </LaneBoundsContext.Provider>
        </section>
      </main>
    </ContextActionsProvider>
  );
}

const previewGlobal = globalThis as typeof globalThis & { __sharedLayoutPreviewRoot?: Root };
const previewRoot = previewGlobal.__sharedLayoutPreviewRoot ?? createRoot(document.getElementById("root")!);
previewGlobal.__sharedLayoutPreviewRoot = previewRoot;
previewRoot.render(<Preview />);

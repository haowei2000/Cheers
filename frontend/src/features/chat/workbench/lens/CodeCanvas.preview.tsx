import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Button as UiButton } from "@/components/ui/button";
import { Textarea as UiTextarea } from "@/components/ui/textarea";
import { ArtifactLens } from "./ArtifactLens";
import "@/index.css";

// Run `npm run dev`, then open /dev/code-canvas.html. Drag a card in Design Mode:
// the same source shown at right should change its data-cheers-position literal.
const START = `export default function Dashboard() {
  return <main data-cheers-canvas style={{height: "100%", background: "#f5f2ed"}}>
    <article data-cheers-id="revenue-card" data-cheers-position="40,50"
      style={{width: 230, padding: 20, background: "white", borderRadius: 8, boxShadow: "0 3px 12px #0002"}}>
      <strong>Revenue</strong><p>€42,180 this month</p>
    </article>
    <article data-cheers-id="orders-card" data-cheers-position="320,140"
      style={{width: 230, padding: 20, background: "white", borderRadius: 8, boxShadow: "0 3px 12px #0002"}}>
      <strong>Orders</strong><p>318 completed</p>
    </article>
  </main>;
}`;

function Preview() {
  const [source, setSource] = useState(START);
  const [inspectorActive, setInspectorActive] = useState(true);
  const [lastPick, setLastPick] = useState("Select or drag a card");
  return (
    <main className="flex h-screen flex-col bg-canvas p-4 text-content-primary">
      <header className="mb-3 flex items-center gap-3">
        <UiButton onClick={() => setInspectorActive((active) => !active)}>
          {inspectorActive ? "Leave Design Mode" : "Enter Design Mode"}
        </UiButton>
        <span className="text-compact text-content-secondary">{lastPick}</span>
      </header>
      <div className="flex min-h-0 flex-1 gap-3">
        <section className="min-w-0 flex-3 overflow-hidden rounded-sm ring-1 ring-line-subtle">
          <ArtifactLens
            data={source}
            path="cards/dashboard.tsx"
            mode="react"
            config={undefined}
            onChange={(next) => setSource(String(next))}
            inspectorActive={inspectorActive}
            requestContextPick={(_event, target) => setLastPick(target.locator ?? target.label)}
          />
        </section>
        <UiTextarea
          className="min-w-0 flex-2 resize-none font-code text-compact"
          aria-label="Code canvas source"
          value={source}
          onChange={(event) => setSource(event.target.value)}
        />
      </div>
    </main>
  );
}

const previewGlobal = globalThis as typeof globalThis & { __codeCanvasPreviewRoot?: Root };
const root = previewGlobal.__codeCanvasPreviewRoot ?? createRoot(document.getElementById("root")!);
previewGlobal.__codeCanvasPreviewRoot = root;
root.render(<Preview />);

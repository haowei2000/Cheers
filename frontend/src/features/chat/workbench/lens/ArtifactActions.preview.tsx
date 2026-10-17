import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArtifactLens } from "./ArtifactLens";
import { createInteractionDispatcher } from "../interaction";
import "@/index.css";

const source = `/** @cheers-actions
[{"actionId":"report.prepare","name":"cheers.request","botId":"11111111-2222-3333-4444-555555555555","payload":{"topic":null}}]
*/
export default function App() {
  useEffect(() => { window.CheersBridge.request("report.prepare", {topic:"Automatic proposal"}); }, []);
  return <main>
    <p>Mount proposes a request, but cannot send it.</p>
    <form name="draft"><label>Topic <input name="topic" defaultValue="Draft topic" /></label><button type="submit">Prepare draft</button></form>
  </main>;
}`;

function Preview() {
  const [attempts, setAttempts] = useState(0);
  const [draft, setDraft] = useState("");
  const interactions = useMemo(() => {
    let calls = 0;
    return createInteractionDispatcher({
      composeMessage: setDraft,
      requestInteraction: async () => {
        setAttempts(++calls);
        if (calls === 1) throw new Error("Simulated network failure");
        return { msg_id: "fixture-receipt" };
      },
    });
  }, []);
  return <main className="space-y-4 bg-canvas p-4 text-content-primary">
    <h1 className="text-comfortable font-semibold">Artifact host approval and feedback</h1>
    <p className="text-body-secondary">Local fixture. No gateway or Bot runs. The first approved request fails; retry succeeds.</p>
    <p role="status">Dispatch attempts: {attempts}</p>
    <div className="h-96">
      <ArtifactLens data={source} mode="react" path="cards/approval.tsx" sourceVersion={1} presentation="minimal"
        config={undefined} readOnly onChange={() => {}} onInteraction={interactions} />
    </div>
    <p role="status">Composer draft: {draft}</p>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);

import { useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/ui/field";
import { A2UILens } from "./A2UILens";
import example from "./example.a2ui.json";
import { createInteractionDispatcher, type ResourceInteraction } from "../../interaction";
import { makeFsClient } from "../../fsClient";
import { fileResourceStore } from "../../fileResource";
import { ResourceCardProvider } from "../../../ResourceCardContext";
import { ResourceRefCards } from "../../../ResourceRefCards";
import { LocatorOpenContext } from "../../../messageLinks";
import "@/index.css";

function Preview() {
  const [source, setSource] = useState(JSON.stringify(example, null, 2));
  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState("");
  const [version, setVersion] = useState(1);
  const [receipt, setReceipt] = useState("");
  const requestInteraction = useCallback(async (event: ResourceInteraction) => {
    setReceipt(JSON.stringify(event, null, 2));
    return { msg_id: "local-fixture-receipt" };
  }, []);
  const fs = useMemo(() => makeFsClient(async () => ({ path: "forms/report.a2ui.json", content: JSON.stringify(example), version: 1, is_dir: false }), "preview"), []);
  const resources = fileResourceStore(fs);
  // Local-only fixture transport. Publish source edits into the SAME snapshot
  // shared by the reply preview; no production request or native action runs.
  fs.read = async () => ({ path: "forms/report.a2ui.json", content: source, version, is_dir: false });
  const dispatch = useMemo(() => createInteractionDispatcher({ composeMessage: setDraft, openLocator: setTarget, requestInteraction }), [requestInteraction]);
  const parsed = useMemo(() => {
    try { return { data: JSON.parse(source), error: "" }; }
    catch { return { data: null, error: "Invalid JSON. Correct the source to restore the preview." }; }
  }, [source]);
  return <main className="min-h-screen space-y-4 bg-canvas p-4 text-content-primary">
    <header className="space-y-2">
      <h1 className="text-comfortable font-semibold">Interactive resource preview</h1>
      <p className="text-body-secondary">Local fixture: reply preview and full view share a resource. Actions prepare a draft, display a URI, or produce a simulated request receipt. No real Bot, gateway or native action runs.</p>
    </header>
    <div className="grid min-w-0 gap-4 md:grid-cols-2">
      <section aria-label="Rendered resource" className="min-w-0">
        <ResourceCardProvider fs={fs} channelId="preview" filesTick={version} openLocator={setTarget} composeMessage={setDraft} requestInteraction={requestInteraction}>
          <LocatorOpenContext.Provider value={setTarget}>
            <p className="text-body">Reply: The report form is ready.</p>
            <ResourceRefCards cards={[{ v: 1, kind: "resource_ref", uri: "cheers:desk/forms/report.a2ui.json", title: "Report form", description: "Fill the form here or open the full view." }]} />
          </LocatorOpenContext.Provider>
        </ResourceCardProvider>
        <p className="mt-4 text-body-secondary">Full Workbench view</p>
        {parsed.error ? <p role="alert" className="text-body-error">{parsed.error}</p> : <A2UILens data={parsed.data} sourceVersion={version} path="forms/report.a2ui.json" config={undefined} onChange={() => {}} onInteraction={dispatch} />}
      </section>
      <Field label="Resource source" htmlFor="a2ui-source" className="min-w-0">
        <Textarea id="a2ui-source" value={source} onChange={(event) => {
          const content = event.target.value;
          setSource(content); setVersion((value) => value + 1);
          resources.publish("forms/report.a2ui.json", { path: "forms/report.a2ui.json", content, version: version + 1, is_dir: false });
        }} rows={18} className="w-full font-code text-regular" />
      </Field>
    </div>
    <Field label="Chat draft" htmlFor="a2ui-draft">
      <Textarea id="a2ui-draft" value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} />
    </Field>
    {receipt && <Field label="Simulated request receipt" htmlFor="a2ui-receipt">
      <Textarea id="a2ui-receipt" value={receipt} readOnly rows={8} className="font-code text-regular" />
    </Field>}
    {target && <p role="status" className="break-all text-body-secondary">Navigation requested: {target}</p>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Preview />);

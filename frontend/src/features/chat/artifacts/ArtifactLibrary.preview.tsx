import { createRoot } from "react-dom/client";
import { AnnotationPreviewProvider } from "@/features/annotations/previewSupport";
import { ContextActionsProvider } from "@/components/ui/context-actions";
import { ThemeProvider } from "@/components/ui/theme";
import { ArtifactLibrary } from "./ArtifactLibrary";
import type { Artifact } from "./client";
import { makeFsClient, type SendResourceReq } from "../workbench/fsClient";
import type { WorkbenchContext } from "../workbench/context";
import "../workbench/lens/builtins";
import "@/index.css";

const files: Record<string, string> = {
  "Report.md": "# Research report\n\nOne artifact, available from the conversation and the library.\n",
  "Analysis.html": '<main style="padding:24px"><h1>Sales analysis</h1><p>HTML artifact preview</p></main>',
  "Dashboard.tsx": 'export default function Dashboard() { return <main data-cheers-canvas><article data-cheers-id="revenue" data-cheers-position="30,40" style={{padding:24}}>Revenue: €42,180</article></main>; }',
};
const artifacts: Artifact[] = Object.keys(files).map((title, index) => ({
  artifact_id: `00000000-0000-4000-8000-00000000000${index}`, channel_id: "preview",
  uri: `cheers:artifact/00000000-0000-4000-8000-00000000000${index}`,
  title, source_kind: "text", source_id: `source-${index}`, path: title,
  content_type: null, size_bytes: files[title].length, version: 1, source_version: 1,
  availability: "ready", created_at: "2026-10-27T00:00:00Z", updated_at: "2026-10-27T00:00:00Z", expires_at: null,
}));
artifacts.push({ ...artifacts[0], artifact_id: "00000000-0000-4000-8000-000000000009",
  uri: "cheers:artifact/00000000-0000-4000-8000-000000000009", title: "Expired attachment.pdf",
  source_kind: "attachment", path: null, availability: "expired" });
const send: SendResourceReq = async (verb, params) => {
  if (verb === "channel.artifacts.list") return { artifacts, next_cursor: null };
  if (verb === "channel.artifacts.get" || verb === "channel.artifacts.resolve" || verb === "channel.artifacts.read" || verb === "channel.artifacts.update") {
    const item = artifacts.find((item) => item.artifact_id === params.artifact_id || item.uri === String(params.uri ?? "").split("#")[0] || item.path === params.path);
    if (!item) throw new Error("Artifact not found");
    if (verb === "channel.artifacts.read") return { artifact: item, kind: "text", content: files[item.path!], truncated: false };
    if (verb === "channel.artifacts.update") {
      if (params.if_version !== item.version) throw new Error("VERSION_CONFLICT");
      files[item.path!] = String(params.content);
      item.version++;
      return { artifact: { ...item }, version: item.version, path: item.path };
    }
    return { ...item };
  }
  const path = String(params.path ?? "");
  if (verb === "fs.ls") return { entries: Object.entries(files).map(([path, content]) => ({path, version: 1, is_dir: false, size_bytes: content.length})) };
  if (verb === "fs.read") {
    if (!(path in files)) throw new Error("File not found");
    return { path, content: files[path], version: 1, is_dir: false };
  }
  if (verb === "fs.write") { files[path] = String(params.content); return { path, version: 2 }; }
  throw new Error(`Unsupported preview operation: ${verb}`);
};
const ctx: WorkbenchContext = { active: true, channelId: "preview", fs: makeFsClient(send, "preview"),
  sendResourceReq: send, pinned: [], togglePin: () => {}, rendererExtensions: [], bindings: {},
  setBinding: () => {}, configs: {}, composeMessage: (text) => { document.title = text; } };

createRoot(document.getElementById("root")!).render(<ThemeProvider><ContextActionsProvider><AnnotationPreviewProvider>
  <main className="h-screen bg-panel text-content-primary"><ArtifactLibrary ctx={ctx} /></main>
</AnnotationPreviewProvider></ContextActionsProvider></ThemeProvider>);

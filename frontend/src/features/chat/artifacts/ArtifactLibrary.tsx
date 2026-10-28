import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { ActionButton } from "@/components/ui/action-button";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Banner } from "@/components/ui/banner";
import { ItemList, WorkbenchItem } from "@/components/ui/item";
import { SurfaceSpinner } from "@/components/ui/spinner";
import type { WorkbenchContext } from "../workbench/context";
import { FilePanel } from "../workbench/panels/FilePanel";
import { ArtifactLens } from "../workbench/lens/ArtifactLens";
import { formatOf } from "../workbench/renderers/registry";
import { FileGrid } from "../fileView";
import { locatorToContextItem, useContextPickStore } from "../context/contextPick";
import { parseLocator } from "../locator";
import { artifactEditorClient, makeArtifactClient, type Artifact, type ArtifactContent } from "./client";

const availabilityLabel: Record<Artifact["availability"], string> = {
  ready: "Ready", pending: "Preparing", expired: "Expired", deleted: "Deleted", failed: "Failed",
};

export function artifactType(artifact: Pick<Artifact, "title" | "content_type">): string {
  const format = formatOf(artifact.title);
  if (format === "html" || format === "react") return "Interactive page";
  if (/\.canvas\.(json|ya?ml)$/i.test(artifact.title)) return "Canvas";
  if (format === "markdown") return "Document";
  if (artifact.content_type?.startsWith("image/")) return "Image";
  if (artifact.content_type === "application/pdf") return "PDF";
  return "File";
}

/** One shared library for authored documents and delivered files. FilePanel is
 * still the source/preview editing host, so there is no second editing buffer. */
export function ArtifactLibrary({ ctx, target, onDirtyChange }: {
  ctx: WorkbenchContext; target?: string; onDirtyChange?: (dirty: boolean) => void;
}) {
  const client = useMemo(() => makeArtifactClient(ctx.sendResourceReq, ctx.channelId), [ctx.sendResourceReq, ctx.channelId]);
  const [items, setItems] = useState<Artifact[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const openingGeneration = useRef(0);
  const dirty = useRef(false);
  const [hasEdits, setHasEdits] = useState(false);
  const reportDirty = useCallback((value: boolean) => {
    dirty.current = value;
    setHasEdits(value);
    onDirtyChange?.(value);
  }, [onDirtyChange]);
  const addContext = useContextPickStore((state) => state.add);

  const refresh = useCallback(async (before?: string) => {
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const page = await client.list(before);
      if (request !== generation.current) return;
      setItems((current) => before
        ? [...new Map([...current, ...page.artifacts].map((item) => [item.artifact_id, item])).values()]
        : page.artifacts);
      setNext(page.next_cursor);
    } catch (reason) {
      if (request === generation.current) setError(reason instanceof Error ? reason.message : "Could not load artifacts");
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    const requests = generation;
    void refresh();
    return () => { requests.current++; };
  }, [refresh, ctx.filesTick]);

  const open = useCallback(async (uri: string) => {
    if (dirty.current) { setError("Save or discard your changes before opening another artifact."); return; }
    const request = ++openingGeneration.current;
    setOpening(true);
    setError(null);
    try {
      const artifact = await (uri.startsWith("cheers:") ? client.resolve(uri) : client.resolvePath(uri));
      if (request === openingGeneration.current) setSelected(artifact);
    } catch (reason) {
      if (request === openingGeneration.current) setError(reason instanceof Error ? reason.message : "Could not open artifact");
    } finally {
      if (request === openingGeneration.current) setOpening(false);
    }
  }, [client]);

  useEffect(() => {
    const requests = openingGeneration;
    if (dirty.current) { setError("Save or discard your changes before opening another artifact."); return; }
    setSelected(null);
    if (target) void open(target);
    return () => { requests.current++; };
  }, [target, open]);

  // Metadata changes refresh availability while the existing editor owns dirty
  // content and conflict resolution. Do not remount the editor on every version.
  const selectedId = selected?.artifact_id;
  const editorFs = useMemo(() => selected
    ? artifactEditorClient(ctx.fs, ctx.sendResourceReq, ctx.channelId, selected) : ctx.fs,
  [ctx.fs, ctx.sendResourceReq, ctx.channelId, selected]);
  useEffect(() => {
    if (!selectedId) return;
    let alive = true;
    void client.get(selectedId).then((item) => {
      if (!alive) return;
      if (dirty.current) {
        // A rename/deletion must not unmount an editor containing local changes.
        setError("This artifact changed. Save or discard your edits before refreshing.");
        return;
      }
      setSelected(item);
    }).catch((reason) => {
      if (alive) setError(reason instanceof Error ? reason.message : "Could not refresh artifact");
    });
    return () => { alive = false; };
  }, [client, selectedId, ctx.filesTick]);

  const targetLocator = target ? parseLocator(target) : null;
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex items-center gap-2 p-2">
      <ButtonGroup label="Artifact navigation">
        {selected && <ActionButton action="back" context="windowChrome" accessibleLabel="Back to artifacts"
          disabled={hasEdits}
          onClick={() => { openingGeneration.current++; setSelected(null); setOpening(false); }} />}
        <ActionButton action="refresh" context="windowChrome" accessibleLabel="Refresh artifacts"
          disabled={hasEdits}
          onClick={() => { void refresh(); if (selected) void open(selected.uri); }} />
      </ButtonGroup>
      <span className="min-w-0 flex-1 truncate font-utility text-regular text-content-primary">{selected?.title ?? "All artifacts"}</span>
      {selected && <ButtonGroup label="Artifact actions">
        <ActionButton action="copy" context="security" accessibleLabel="Copy artifact link"
          onClick={() => { void navigator.clipboard.writeText(selected.uri).catch(() => setError("Could not copy the link")); }} />
        <Button action="addContext" content="icon" variant="plain" aria-label="Add artifact to context" onClick={() => {
          const item = locatorToContextItem(selected.uri, selected.title);
          if (item) addContext(ctx.channelId, item);
        }} />
      </ButtonGroup>}
    </div>
    {error && <Banner severity="error">{error}</Banner>}
    {opening ? <SurfaceSpinner /> : selected ? (
      selected.availability !== "ready" ? <Banner severity="warning">
        {availabilityLabel[selected.availability]}. {selected.availability === "expired" ? "Ask the author to deliver a new copy." : "This artifact is not available to open."}
      </Banner> : selected.source_kind === "text" && selected.path ? (
        <FilePanel key={selected.artifact_id} initialTreeOpen={false} onDirtyChange={reportDirty} ctx={{ ...ctx,
          fs: editorFs,
          artifactId: selected.artifact_id,
          openTarget: selected.path,
          openInspectableId: targetLocator?.kind === "desk" || targetLocator?.kind === "artifact" ? targetLocator.inspectableId : undefined,
        }} />
      ) : <AttachmentContent key={selected.artifact_id} artifact={selected} ctx={ctx} />
    ) : <div className="min-h-0 flex-1 overflow-y-auto p-2" aria-busy={loading}>
      <ItemList presentationLevel="medium" controlSize="regular" aria-label="Artifacts">
        {items.map((item) => <WorkbenchItem key={item.artifact_id} title={item.title}
          leading={<FileText className="h-4 w-4" aria-hidden="true" />}
          status={item.availability === "ready" ? artifactType(item) : availabilityLabel[item.availability]}
          onClick={() => { void open(item.uri); }} />)}
      </ItemList>
      {loading ? <SurfaceSpinner /> : !items.length && !error ? <p className="p-4 text-regular text-content-muted">No artifacts yet. Upload a file or ask a Bot to create one.</p> : null}
      {next && <Button action="more" variant="secondary" disabled={loading} onClick={() => { void refresh(next); }}>Load more</Button>}
    </div>}
  </div>;
}

function AttachmentContent({ artifact, ctx }: { artifact: Artifact; ctx: WorkbenchContext }) {
  const format = formatOf(artifact.title);
  const interactive = format === "html" || format === "react";
  const [content, setContent] = useState<ArtifactContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!interactive) return;
    let alive = true;
    void makeArtifactClient(ctx.sendResourceReq, ctx.channelId).read(artifact.artifact_id)
      .then((value) => { if (alive) setContent(value); })
      .catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : "Could not load preview"); });
    return () => { alive = false; };
  }, [artifact.artifact_id, ctx.channelId, ctx.sendResourceReq, interactive]);
  if (error) return <Banner severity="error">{error}</Banner>;
  if (interactive && !content) return <SurfaceSpinner />;
  if (interactive && content?.content && !content.truncated) return <ArtifactLens
    data={content.content} path={artifact.title} mode={format === "html" ? "html" : "react"}
    config={undefined} readOnly onChange={() => {}} openLocator={ctx.openLocator}
    onFormSubmit={({ actionId, formData }) => ctx.composeMessage?.(`[Action ${actionId}] ${JSON.stringify(formData)}`)} />;
  return <div className="min-h-0 flex-1 overflow-y-auto p-4">
    {interactive && <Banner severity="warning">{content?.note ?? "Preview unavailable. Download the complete file."}</Banner>}
    <FileGrid channelId={ctx.channelId} files={[{ file_id: artifact.source_id,
      original_filename: artifact.title, content_type: artifact.content_type ?? undefined,
      size_bytes: artifact.size_bytes }]} />
  </div>;
}

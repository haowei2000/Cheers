import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Banner } from "@/components/ui/banner";
import { ItemList, WorkbenchItem } from "@/components/ui/item";
import type { WorkbenchContext } from "../workbench/context";
import { viewChange, type ViewChange } from "../workbench/renderers/viewChanges";
import type { Artifact, ArtifactClient } from "./client";

/** Diagnostics for the currently loaded page(s); fetching another page scans it too.
 * Cancellable bounded reads keep switching channels from showing another channel's report. */
export function ArtifactViewChanges({ items, client, ctx, onRenamed }: {
  items: Artifact[]; client: ArtifactClient; ctx: WorkbenchContext; onRenamed: () => void;
}) {
  const [changes, setChanges] = useState<Array<{ artifact: Artifact; change: ViewChange }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setChanges([]);
    setError(null);
    const scan = async () => {
      let bindings: Record<string, string> = {};
      try {
        const raw = JSON.parse((await ctx.fs.read(".workbench.json")).content);
        bindings = { ...raw.bindings };
        for (const view of raw.views ?? []) if (view.path && view.renderer) bindings[view.path] ??= view.renderer;
      } catch { /* Configuration may not exist. Content diagnostics still work. */ }
      try { bindings = { ...bindings, ...JSON.parse(localStorage.getItem(`cheers.workbench.personal-bindings.${ctx.channelId}`) ?? "{}") }; } catch { /* Old local settings may be corrupt. */ }
      const candidates = items.filter((item) => item.source_kind === "text" && item.path && item.availability === "ready");
      for (let start = 0; alive && start < candidates.length; start += 4) {
        const rows = await Promise.all(candidates.slice(start, start + 4).map(async (artifact) => {
          try {
            const result = await client.read(artifact.artifact_id);
            if (typeof result.content !== "string" || result.truncated) return null;
            const change = viewChange(artifact.path!, result.content, ctx.rendererExtensions, bindings[artifact.path!]);
            return change ? { artifact, change } : null;
          } catch {
            if (alive) setError("Some files could not be checked. Refresh to try again.");
            return null;
          }
        }));
        if (alive) setChanges((current) => [...current, ...rows.filter((row): row is NonNullable<typeof row> => row !== null)]);
      }
    };
    void scan();
    return () => { alive = false; };
  }, [items, client, ctx.fs, ctx.channelId, ctx.rendererExtensions]);

  return <>
    {error && <Banner severity="warning">{error}</Banner>}
    {changes.length > 0 && <ItemList presentationLevel="medium" controlSize="regular" aria-label="Files whose view changed">
      <p className="p-2 text-regular text-content-secondary">Views now follow file names. These loaded files have changed views.</p>
      {changes.map(({ artifact, change }) => <WorkbenchItem key={artifact.artifact_id} title={artifact.path!}
        status={`${change.previous} → ${change.current}`}
        subtitle={change.suggestedPath ? `Rename to ${change.suggestedPath}` : undefined}
        actions={change.suggestedPath ? <Button action="rename" variant="plain"
          aria-label={`Rename to ${change.suggestedPath}`} title={`Rename to ${change.suggestedPath}`}
          disabled={busy !== null} onClick={async () => {
            setBusy(artifact.artifact_id); setError(null);
            try {
              await client.rename(artifact.artifact_id, change.suggestedPath!, artifact.version);
              onRenamed();
            } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not rename the file. Refresh and try again."); }
            finally { setBusy(null); }
          }}>Rename</Button> : <span className="text-compact text-content-muted">Update the extension to declare a suffix.</span>} />)}
    </ItemList>}
  </>;
}

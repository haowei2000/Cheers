import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { ActionButton } from "@/components/ui/action-button";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { parseLocator } from "./locator";
import { ResourceCardContext } from "./ResourceCardContext";
import { fileResourceStore } from "./workbench/fileResource";
import { formatFor, errMsg } from "./workbench/jsonFile";
import { A2UILens } from "./workbench/lens/a2ui/A2UILens";
import { ArtifactLens } from "./workbench/lens/ArtifactLens";

function DeskPreview({ path, active }: { path: string; active: boolean }) {
  const host = useContext(ResourceCardContext)!;
  const store = useMemo(() => fileResourceStore(host.fs), [host.fs]);
  const subscribe = useCallback((notify: () => void) => store.subscribe(path, notify), [store, path]);
  const snapshot = useSyncExternalStore(subscribe, () => store.snapshot(path), () => store.snapshot(path));
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  useEffect(() => {
    if (active) void store.refresh(path, host.filesTick).catch(() => {});
  }, [store, path, host.filesTick, active]);
  const parsed = useMemo(() => {
    try { return { data: snapshot.file ? formatFor(path).parse(snapshot.file.content) : null, error: "" }; }
    catch (error) { return { data: null, error: errMsg(error) }; }
  }, [path, snapshot.file]);
  const refresh = () => { void store.read(path).catch(() => {}); };
  if (snapshot.error) return <div className="space-y-2">
    <p role="alert" className="text-body-error">Could not load preview: {errMsg(snapshot.error)}</p>
    <Button action="retry" controlSize="compact" onClick={refresh} />
  </div>;
  if (!snapshot.file) return <p role="status" className="text-body-secondary">Loading resource preview…</p>;
  const file = snapshot.file;
  if (file.is_dir) return <p className="text-body-secondary">Open this folder to browse its files.</p>;
  const isA2ui = parsed.data && typeof parsed.data === "object" && "a2ui" in parsed.data;
  const isTsx = /\.(tsx|jsx)$/i.test(path);
  const limit = expanded ? 12_000 : 1_200;
  const sourceFont = /\.(md|txt)$/i.test(path) ? "font-reading leading-reading" : "font-code";
  return <div className="space-y-2" aria-label={`Preview of ${path}`} aria-busy={snapshot.loading}>
    <div id={contentId} className={expanded ? "max-h-96 overflow-auto" : "min-w-0"}>
      {parsed.error && !isTsx ? (
        <p role="alert" className="text-body-error">Preview syntax error: {parsed.error}. Open the full view to correct it.</p>
      ) : isA2ui ? (
        <A2UILens data={parsed.data} path={path} sourceVersion={file.version} config={undefined}
          presentation={expanded ? "medium" : "minimal"} onChange={() => {}} onInteraction={host.interactions} />
      ) : isTsx ? (
        <div className={`w-full overflow-hidden rounded-sm ring-1 ring-border ${expanded ? "h-96" : "h-52"}`}>
          <ArtifactLens
            data={file.content}
            path={path}
            sourceVersion={file.version}
            mode="react"
            presentation={expanded ? "medium" : "minimal"}
            inspectorActive={false}
            readOnly={true}
            config={undefined}
            onChange={() => {}}
            onInteraction={host.interactions}
          />
        </div>
      ) : (
        <pre className={`${expanded ? "" : "line-clamp-4 "}whitespace-pre-wrap break-words text-regular ${sourceFont}`}>{file.content.slice(0, limit) || "Empty file."}{file.content.length > limit ? "\n…" : ""}</pre>
      )}
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <ControlTrigger controlSize="compact" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded((value) => !value)}>{expanded ? "Collapse" : "Expand"}</ControlTrigger>
      <ActionButton action="refresh" context="windowChrome" controlSize="compact" disabled={snapshot.loading} onClick={refresh} aria-label={`Refresh preview of ${path}`} />
      <span className="text-body-secondary">Version {file.version}{snapshot.loading ? " · Refreshing…" : ""}</span>
    </div>
  </div>;
}

/** Do not fetch every card in message history. Offscreen cards keep their
 * ordinary URI entry; visible Desk cards join the shared authorized file read. */
export function ResourceInlinePreview({ uri }: { uri: string }) {
  const host = useContext(ResourceCardContext);
  const target = parseLocator(uri);
  const canPreview = !!host && target?.kind === "desk";
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  const [activated, setActivated] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (!canPreview || !element.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const shown = entries.some((entry) => entry.isIntersecting);
      setVisible(shown);
      if (shown) setActivated(true);
    }, { rootMargin: "160px" });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [canPreview]);
  if (!host || target?.kind !== "desk") return null;
  return <div ref={element} className="min-w-0 px-3 pb-3 font-utility text-regular">
    {activated ? <DeskPreview key={target.path} path={target.path} active={visible} /> : <p className="text-body-secondary">Preview loads when this card is visible.</p>}
  </div>;
}

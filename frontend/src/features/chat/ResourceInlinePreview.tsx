import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActionButton } from "@/components/ui/action-button";
import { ChevronUp, Eye } from "lucide-react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { ResourceEnclosureMetadataContext } from "./ResourceEnclosure";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { parseLocator } from "./locator";
import { ResourceCardContext } from "./ResourceCardContext";
import { useNearViewport } from "@/hooks/useNearViewport";
import { fileResourceStore } from "./workbench/fileResource";
import { formatFor, errMsg } from "./workbench/jsonFile";
import { A2UILens } from "./workbench/lens/a2ui/A2UILens";
import { ArtifactLens } from "./workbench/lens/ArtifactLens";
import { resolveDeskResource,type ResolvedDeskResource } from "@/api/resources";
import { sendResourceInteraction } from "@/api/messages";
import { makeFsClient } from "./workbench/fsClient";
import { ResourceCardProvider } from "./ResourceCardContext";
import { formatLocator } from "./locator";

function GlobalPreview({uri}:{uri:string}) {
  const parent=useContext(ResourceCardContext)!;
  const [resource,setResource]=useState<ResolvedDeskResource>();
  const [error,setError]=useState("");
  useEffect(()=>{let active=true;resolveDeskResource(uri).then(r=>{if(active){setResource(r);setError("");}}).catch(e=>{if(active)setError(errMsg(e));});return()=>{active=false;};},[uri,parent.filesTick]);
  const fs=useMemo(()=>makeFsClient(async(verb,params)=>{
    if(verb!=="fs.read")throw new Error("Use Workbench to edit this resource.");
    if(!resource)throw new Error("Resource is loading");
    return resolveDeskResource(params.path===resource.path?uri:formatLocator({kind:"desk",path:String(params.path)}),resource.channel_id);
  },resource?.channel_id??""),[resource,uri]);
  if(error)return <p role="alert" className="text-body-error">{error}</p>;
  if(!resource)return <p role="status" className="text-body-secondary">Resolving resource…</p>;
  return <ResourceCardProvider fs={fs} channelId={resource.channel_id} filesTick={parent.filesTick}
    openLocator={(target)=>{void resolveDeskResource(target,resource.channel_id).then(r=>parent.interactions({kind:"open",uri:r.uri})).catch(e=>setError(errMsg(e)));}}
    composeMessage={(text)=>{void parent.interactions({kind:"compose",actionId:"resource.draft",formData:{text}});}}
    requestInteraction={event=>sendResourceInteraction(resource.channel_id,event)}>
    <DeskPreview path={resource.path} active />
  </ResourceCardProvider>;
}

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
  const refresh = useCallback(() => { void store.read(path).catch(() => {}); },[store,path]);
  const reportMetadata=useContext(ResourceEnclosureMetadataContext);
  useEffect(()=>{
    reportMetadata?.({path,version:snapshot.file?.version,refreshing:snapshot.loading,refresh});
    return()=>reportMetadata?.(undefined);
  },[reportMetadata,path,snapshot.file?.version,snapshot.loading,refresh]);
  if (snapshot.error) return <div className="space-y-2">
    <p role="alert" className="text-body-error">Could not load preview: {errMsg(snapshot.error)}</p>
    <ActionButton action="retry" context="resourceCard" controlSize="compact" accessibleLabel={`Retry preview of ${path}`} onClick={refresh} />
  </div>;
  if (!snapshot.file) return <p role="status" className="text-body-secondary">Loading resource preview…</p>;
  const file = snapshot.file;
  if (file.is_dir) return <p className="text-body-secondary">Open this folder to browse its files.</p>;
  const isA2ui = parsed.data && typeof parsed.data === "object" && "a2ui" in parsed.data;
  const isTsx = /\.(tsx|jsx)$/i.test(path);
  const limit = expanded ? 12_000 : 1_200;
  const isMarkdown=/\.md$/i.test(path);
  const isText=/\.txt$/i.test(path);
  return <div className="space-y-2" aria-label={`Preview of ${path}`} aria-busy={snapshot.loading}>
    <div id={contentId} className={expanded ? "max-h-96 overflow-auto" : "min-w-0"}>
      {parsed.error && !isTsx ? (
        <p role="alert" className="text-body-error">Preview syntax error: {parsed.error}. Open the full view to correct it.</p>
      ) : isA2ui ? (
        <A2UILens data={parsed.data} path={path} sourceVersion={file.version} resourceUri={file.uri} config={undefined}
          presentation={expanded ? "medium" : "minimal"} onChange={() => {}} onInteraction={host.interactions} />
      ) : isTsx ? (
        <div className={`w-full overflow-hidden rounded-sm bg-canvas ${expanded ? "h-96" : "h-52"}`}>
          <ArtifactLens
            data={file.content}
            path={path}
            sourceVersion={file.version}
            resourceUri={file.uri}
            mode="react"
            presentation={expanded ? "medium" : "minimal"}
            inspectorActive={false}
            readOnly={true}
            config={undefined}
            onChange={() => {}}
            onInteraction={host.interactions}
          />
        </div>
      ) : isMarkdown ? (
        <div><MarkdownRenderer className="text-message" content={file.content.slice(0,expanded?limit:320)||"Empty document."} />{file.content.length>(expanded?limit:320)&&<span className="text-caption">…</span>}</div>
      ) : (
        <pre className={`${expanded ? "" : "line-clamp-4 "}whitespace-pre-wrap break-words text-regular ${isText?"font-reading leading-reading":"font-code text-content-secondary"}`}>{file.content.slice(0, limit) || "Empty file."}{file.content.length > limit ? "\n…" : ""}</pre>
      )}
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <ControlTrigger controlSize="compact" square title={expanded?`Collapse preview of ${path}`:`Expand preview of ${path}`} aria-label={expanded?`Collapse preview of ${path}`:`Expand preview of ${path}`} aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded((value) => !value)}>
        {expanded ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
      </ControlTrigger>
      {snapshot.loading&&<span role="status" className="text-caption">Refreshing…</span>}
    </div>
  </div>;
}

/** Do not fetch every card in message history. Offscreen cards keep their
 * ordinary URI entry; visible Desk cards join the shared authorized file read. */
export function ResourceInlinePreview({ uri }: { uri: string }) {
  const host = useContext(ResourceCardContext);
  const target = parseLocator(uri);
  const canPreview = !!host && (target?.kind === "desk" || (target?.kind==="resource"&&target.resourceKind==="desk"));
  const element = useRef<HTMLDivElement>(null);
  const visible = useNearViewport(element, { rootMargin: "160px", enabled: canPreview });
  const [activated, setActivated] = useState(visible);
  useEffect(() => {
    if (visible) setActivated(true);
  }, [visible]);
  if (!host || !(target?.kind === "desk" || (target?.kind==="resource"&&target.resourceKind==="desk"))) return null;
  return <div ref={element} className="min-w-0 px-4 pb-4 font-utility text-regular">
    {activated ? target.kind==="resource"?<GlobalPreview uri={uri}/>:<DeskPreview key={target.path} path={target.path} active={visible} /> : <p className="text-body-secondary">Preview loads when this card is visible.</p>}
  </div>;
}

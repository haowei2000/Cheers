import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { ArrowUpRight, Info } from "lucide-react";
import { ActionButton } from "@/components/ui/action-button";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { EditorialIcon } from "@/components/ui/editorial-icons";
import { Tip } from "@/components/ui/tip";
import { LocatorOpenContext } from "./messageLinks";
import { parseLocator } from "./locator";

interface PreviewMetadata { path?:string; version?:number; refreshing:boolean; refresh:()=>void }
export const ResourceEnclosureMetadataContext=createContext<((metadata:PreviewMetadata|undefined)=>void)|null>(null);

function resourceLabel(uri:string) {
  const target=parseLocator(uri);
  if(target?.kind==="desk") {
    if(/\.a2ui\.(json|ya?ml)$/i.test(target.path))return "Interactive form";
    if(/\.(tsx|jsx)$/i.test(target.path))return "Canvas";
    return "Document";
  }
  const kind=target?.kind==="resource"?target.resourceKind:target?.kind;
  return ({desk:"Desk file",inbox:"Attachment",ws:"Workspace file",msg:"Message",plan:"Plan",sessions:"Sessions",cost:"Usage",activity:"Activity"} as Record<string,string>)[kind??""]??"Resource";
}

/** A specialized message attachment: title navigation and interactive preview are siblings.
 * Minimal preview / compact controls; shared paper and typography tokens own its appearance. */
export function ResourceEnclosure({uri,title,description,number,children}:{uri:string;title?:string;description?:string;number:number;children:ReactNode}) {
  const openLocator=useContext(LocatorOpenContext);
  const [details,setDetails]=useState(false);
  const [metadata,setMetadata]=useState<PreviewMetadata>();
  const [copyState,setCopyState]=useState("");
  const detailsId=useId();
  const target=parseLocator(uri);
  const fallback=target?.kind==="desk"?target.path.split("/").pop():resourceLabel(uri);
  const label=title||fallback||"Linked resource";
  return <section className="resource-enclosure min-w-0 rounded-sm bg-panel" aria-label={label}>
    <ResourceEnclosureMetadataContext.Provider value={setMetadata}>
      <header className="flex min-w-0 items-start gap-3 p-4 pb-3">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2 text-caption">
            <EditorialIcon name="attachment" contentSize="small" />
            <span className="font-utility">Enclosure {String(number).padStart(2,"0")} · {metadata?.path?resourceLabel(`cheers:desk/${metadata.path}`):resourceLabel(uri)}</span>
          </div>
          <a href={`#workspace-ref-${encodeURIComponent(uri)}`} onClick={event=>{event.preventDefault();openLocator?.(uri);}}
            className="group inline-flex max-w-full items-center gap-2 rounded-sm font-utility text-regular font-semibold text-content-primary underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
            aria-label={`Open ${label}`}>
            <span className="min-w-0 break-words">{label}</span><ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden="true" />
          </a>
        </div>
        <Tip content={description || "View the resource link and source version."} align="end">
        <ControlTrigger controlSize="compact" square aria-label={`Details for ${label}`} aria-expanded={details} aria-controls={detailsId} onClick={()=>setDetails(value=>!value)}>
          <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
        </ControlTrigger>
        </Tip>
      </header>
      {details&&<div id={detailsId} className="mx-4 mb-4 space-y-3 rounded-sm bg-canvas p-3">
        {description&&<p className="font-reading text-regular leading-reading text-content-secondary">{description}</p>}
        <dl className="space-y-2 text-caption"><div><dt>Resource link</dt><dd className="mt-1 break-all font-code text-compact text-content-secondary">{uri}</dd></div>
          {metadata?.version!==undefined&&<div className="flex gap-2"><dt>Version</dt><dd>{metadata.version}</dd></div>}
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton action="copy" context="resourceCard" controlSize="compact" onClick={async()=>{
            try {
              await navigator.clipboard.writeText(uri);
              setCopyState("Link copied.");
            } catch {
              setCopyState("Could not copy. Select the resource link above.");
            }
          }} accessibleLabel={`Copy resource link for ${label}`} />
          {metadata&&<ActionButton action="refresh" context="resourceCard" controlSize="compact" disabled={metadata.refreshing} onClick={metadata.refresh} accessibleLabel={`Refresh preview of ${label}`} />}
          {copyState&&<span role="status" className="text-caption">{copyState}</span>}
        </div>
      </div>}
      {children}
    </ResourceEnclosureMetadataContext.Provider>
  </section>;
}

import { useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { ResourceCardProvider } from "./ResourceCardContext";
import { ResourceRefCards } from "./ResourceRefCards";
import { LocatorOpenContext } from "./messageLinks";
import { makeFsClient } from "./workbench/fsClient";
import { ResourceDraftFeedback } from "./workbench/useResourceDraft";
import type { useResourceDraft } from "./workbench/useResourceDraft";
import example from "./workbench/lens/a2ui/example.a2ui.json";
import "@/index.css";

const documents:Record<string,string>={
  "letter/notes.md":"## A note on the next release\n\nThe resource chain is ready for review. This enclosure keeps the details close to the letter, while leaving the conversation easy to read.\n\n- Global links preserve the original resource.\n- Your draft follows you across devices.\n- Device actions wait for your approval.",
  "letter/report.a2ui.json":JSON.stringify(example),
  "letter/terminal.a2ui.json":JSON.stringify({a2ui:"v0.9.1",messages:[
    {version:"v0.9.1",createSurface:{surfaceId:"terminal",catalogId:"urn:cheers:a2ui:catalog:v1"}},
    {version:"v0.9.1",updateComponents:{surfaceId:"terminal",components:[
      {id:"root",component:"Column",children:["note","command","review"]},
      {id:"note",component:"Text",text:"A command for the selected device. Review the draft before sending."},
      {id:"command",component:"TextField",label:"Command",value:{path:"/command"}},
      {id:"review",component:"Button",label:"Prepare a terminal request",action:{event:{name:"cheers.compose",context:{actionId:"terminal.review",payload:{command:{path:"/command"}}}}}}
    ]}},
    {version:"v0.9.1",updateDataModel:{surfaceId:"terminal",path:"/",value:{command:"printf 'Ready for review\\n'"}}}
  ]}),
  "letter/canvas.tsx":"export default function Note(){return <article style={{padding:16,fontFamily:'Georgia,serif'}}><h3 style={{fontSize:16}}>A small interactive enclosure</h3><p>Canvas keeps its expressive content inside the same letter attachment.</p><button onClick={e=>e.currentTarget.textContent='Reviewed'}>Review note</button></article>}",
};
// Artifact links carry only an id; the title, type and availability come from the catalog.
const artifactBase={channel_id:"preview",source_id:"file",size_bytes:412,version:5,source_version:3,created_at:"",updated_at:"",expires_at:null};
const artifacts:Record<string,Record<string,unknown>>={
  "00000000-0000-4000-8000-000000000001":{...artifactBase,title:"notes.md",source_kind:"text",path:"letter/notes.md",content_type:"text/markdown",availability:"ready"},
  "00000000-0000-4000-8000-000000000002":{...artifactBase,title:"quarterly-report.pdf",source_kind:"attachment",path:null,content_type:"application/pdf",availability:"expired"},
};
const sendArtifactRequest=async(verb:string,params:Record<string,unknown>)=>{
  const artifact=artifacts[String(params.artifact_id)];
  if(!artifact)throw new Error("Artifact not found.");
  const described={...artifact,artifact_id:params.artifact_id,uri:`cheers:artifact/${String(params.artifact_id)}`};
  if(verb==="channel.artifacts.get")return described;
  if(verb==="channel.artifacts.read")return {artifact:described,content:documents[String(artifact.path)],kind:"text",truncated:false};
  throw new Error("This fixture is read-only.");
};
function Letter() {
  const [draft,setDraft]=useState("");const [target,setTarget]=useState("");
  const open=useCallback((uri:string)=>setTarget(uri),[]);
  const fs=useMemo(()=>makeFsClient(async(verb,params)=>{
    const path=String(params.path);
    if(verb!=="fs.read")throw new Error("This fixture is read-only.");
    if(!documents[path])throw new Error("The enclosure could not be loaded. Retry when the connection returns.");
    return {path,content:documents[path],version:3,is_dir:false};
  },"preview"),[]);
  const cards=[{path:"notes.md",title:"Release notes",description:"The working notes, enclosed for your review."},{path:"report.a2ui.json",title:"Report request",description:"Complete the short form here, or open the full view."},{path:"terminal.a2ui.json",title:"Terminal request",description:"A device command remains an explicit action."},{path:"canvas.tsx",title:"Interactive note"},{path:"unavailable.txt",title:"Connection interrupted"}];
  const conflict={enabled:true,state:{data:{},revision:2,dirty:true,loaded:true,status:"conflict",error:"Another device updated this draft. Choose which copy to keep."},data:{},setData:()=>{},refresh:async()=>{},keepLocal:async()=>{},useRemote:()=>{}} satisfies ReturnType<typeof useResourceDraft>;
  return <main className="min-w-0 bg-canvas p-4 text-content-primary">
    <article className="mx-auto max-w-2xl space-y-4 py-4">
      <p className="text-section-label">A letter with enclosures</p>
      <p className="text-message">The next part is ready. I have enclosed the notes, a short form, and a terminal request so you can inspect each one without leaving the conversation.</p>
      <ResourceCardProvider fs={fs} channelId="preview" filesTick={0} sendResourceReq={sendArtifactRequest} openLocator={open} composeMessage={setDraft}>
        <LocatorOpenContext.Provider value={open}>
          {cards.map(card=><ResourceRefCards key={card.path} cards={[{v:1,kind:"resource_ref",uri:`cheers:desk/letter/${card.path}`,title:card.title,description:card.description}]} />)}
          {Object.keys(artifacts).map(id=><ResourceRefCards key={id} cards={[{v:1,kind:"resource_ref",uri:`cheers:artifact/${id}`}]} />)}
        </LocatorOpenContext.Provider>
      </ResourceCardProvider>
      <p className="text-message">Once you have reviewed the enclosures, we can continue with the release.</p>
      <section aria-label="Draft conflict example" className="space-y-2"><p className="text-label">Conflict stays visible</p><ResourceDraftFeedback draft={conflict}/></section>
      {draft&&<p role="status" className="break-words text-body-secondary">Draft prepared: {draft}</p>}
      {target&&<p role="status" className="break-all text-caption">Open requested: {target}</p>}
    </article>
  </main>;
}
function Gallery() {
  const [width,setWidth]=useState(390);const [dark,setDark]=useState(false);
  return <main className="min-h-screen space-y-4 bg-canvas p-4 text-content-primary">
    <h1 className="text-title">Letter enclosures · local fixture</h1>
    <p className="text-caption">Document, form, terminal draft, Canvas, loading failure, artifact links (ready and expired) and draft conflict. No remote execution or authentication runs.</p>
    <div role="tablist" aria-label="Preview width" className="flex flex-wrap gap-2">{[390,768,1280].map(size=><ControlTrigger key={size} role="tab" selected={width===size} onClick={()=>setWidth(size)}>{size}px</ControlTrigger>)}</div>
    <Button action="preview" onClick={()=>setDark(value=>!value)} aria-label={dark?"Preview light appearance":"Preview dark appearance"}/>
    <div className="overflow-auto"><iframe key={`${width}:${dark}`} title={`Enclosures at ${width}px, ${dark?"dark":"light"}`} src={`/dev/enclosures.html?frame=1&theme=${dark?"dark":"light"}`} width={width} height={1800} className="max-w-none border-0" /></div>
  </main>;
}
const params=new URLSearchParams(location.search);
document.documentElement.dataset.theme=params.get("theme")??"light";
createRoot(document.getElementById("root")!).render(params.has("frame")?<Letter/>:<Gallery/>);

import { useEffect,useMemo,useState } from "react";
import { readResourceDraft,writeResourceDraft } from "@/api/resources";
import { apiBase } from "@/lib/serverConfig";
import { useAuthStore } from "@/stores/authStore";
import { ActionButton } from "@/components/ui/action-button";
import { Button } from "@/components/ui/button";
import { createResourceDraft,type DraftState } from "./resourceDraft";

export function useResourceDraft(uri:string|undefined,sourceVersion:number|undefined,viewId:string,initial:Record<string,unknown>) {
  const user=useAuthStore(s=>s.user?.user_id);
  const enabled=!!uri&&!!sourceVersion&&!!user;
  const storageKey=`cheers:view-draft:${apiBase()}:${user}:${uri}:${viewId}:1`;
  const [state,setState]=useState<DraftState>({data:initial,revision:0,dirty:false,loaded:false,status:"local"});
  const controller=useMemo(()=>{
    const key={uri:uri??"",view_id:viewId,schema_version:1};
    return createResourceDraft(initial,sourceVersion??0,{
      read:()=>readResourceDraft(key),write:(revision,data)=>writeResourceDraft(key,sourceVersion??0,revision,data),
      loadLocal:()=>{try{return JSON.parse(localStorage.getItem(storageKey)??"null");}catch{return null;}},
      saveLocal:(data,revision,dirty,observedVersion)=>{if(enabled)try{localStorage.setItem(storageKey,JSON.stringify({data,revision,sourceVersion:observedVersion,dirty}));}catch{/* quota: cloud feedback remains visible */}},
    },setState);
  // Initial data belongs to the source revision. Presentation changes retain this controller.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[uri,sourceVersion,viewId,storageKey,enabled]);
  useEffect(()=>{
    controller.activate();
    setState(controller.snapshot());
    if(!enabled)return;
    void controller.refresh();
    const refresh=()=>{if(document.visibilityState==="visible")void controller.refresh();};
    const interval=setInterval(refresh,15_000);window.addEventListener("focus",refresh);
    return()=>{clearInterval(interval);window.removeEventListener("focus",refresh);controller.dispose();};
  },[controller,enabled]);
  useEffect(()=>{
    if(!enabled||!state.dirty||!state.loaded||state.status==="conflict")return;
    const timer=setTimeout(()=>{void controller.save();},700);return()=>clearTimeout(timer);
  },[controller,enabled,state]);
  return {data:state.data,setData:(data:Record<string,unknown>)=>controller.edit(data),state,enabled,
    refresh:()=>controller.refresh(),keepLocal:()=>controller.save(true),useRemote:()=>controller.useRemote()};
}
export function ResourceDraftFeedback({draft}:{draft:ReturnType<typeof useResourceDraft>}) {
  if(!draft.enabled||draft.state.status==="synced"||draft.state.status==="loading")return null;
  const {state}=draft;
  return <div className="space-y-2">
    <p role={state.status==="conflict"?"alert":"status"} className="text-caption">
      {state.status==="saving"?"Syncing draft…":state.status==="offline"?"Draft kept on this device. Reconnect to sync.":state.status==="conflict"?state.error:"Draft saved on this device."}
    </p>
    {(state.status==="conflict"||state.status==="offline")&&<div className="flex flex-wrap items-center gap-2">
      <ActionButton action="refresh" context="resourceCard" controlSize="compact" onClick={()=>void draft.refresh()} accessibleLabel="Reload the cloud draft" />
      {state.status==="conflict"&&<>
        <ActionButton action="save" context="inlineEdit" controlSize="compact" onClick={()=>void draft.keepLocal()} accessibleLabel="Keep my local draft" />
        <Button action="reset" controlSize="compact" onClick={draft.useRemote} aria-label="Use the cloud draft" />
      </>}
    </div>}
  </div>;
}

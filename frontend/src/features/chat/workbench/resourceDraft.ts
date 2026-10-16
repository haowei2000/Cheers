import type { DraftSnapshot } from "@/api/resources";
export interface DraftState {
  data:Record<string,unknown>; revision:number; dirty:boolean; loaded:boolean;
  status:"local"|"loading"|"synced"|"saving"|"offline"|"conflict"; error?:string;
}
/** CAS controller shared by TSX and A2UI. Never overwrites a newer remote draft automatically. */
export function createResourceDraft(initial:Record<string,unknown>,sourceVersion:number,transport:{
  read:()=>Promise<DraftSnapshot>; write:(revision:number,data:Record<string,unknown>)=>Promise<DraftSnapshot>;
  loadLocal:()=>({data:Record<string,unknown>;revision:number;sourceVersion:number;dirty:boolean}|null);
  saveLocal:(data:Record<string,unknown>,revision:number,dirty:boolean,sourceVersion:number)=>void;
},publish:(state:DraftState)=>void) {
  const local=transport.loadLocal();
  let state:DraftState={data:local?.data??initial,revision:local?.revision??0,dirty:local?.dirty??false,loaded:false,status:"loading"};
  let observedVersion=local?.sourceVersion??sourceVersion;
  let remote:DraftSnapshot|undefined; let generation=0;let disposed=false;let saving=false;
  const update=(next:DraftState)=>{state=next;transport.saveLocal(next.data,next.revision,next.dirty,observedVersion);if(!disposed)publish({...next});};
  return {
    activate(){disposed=false;},
    snapshot:()=>state,
    async refresh() {
      if(disposed || saving) return;
      try {
        const latest=await transport.read();if(disposed)return;remote=latest;
        if(state.loaded&&latest.revision<state.revision)return;
        const conflict=latest.stale || observedVersion!==sourceVersion
          || (state.dirty && latest.revision!==state.revision) || latest.revision<state.revision;
        update(conflict?{...state,loaded:true,status:"conflict",error:"The source or draft changed. Review your local inputs before choosing which copy to keep."}
          :{...state,data:state.dirty?state.data:(latest.data??state.data),revision:latest.revision,loaded:true,status:state.dirty?"local":"synced",error:undefined});
      }catch(error){if(!disposed)update({...state,loaded:false,status:"offline",error:String(error)});}
    },
    edit(data:Record<string,unknown>) {
      if(JSON.stringify(data)===JSON.stringify(state.data))return;
      generation++;update({...state,data,dirty:true,status:state.status==="conflict"?"conflict":!state.loaded?"offline":"local"});
    },
    async save(keepLocal=false) {
      if(disposed || saving || !state.loaded || (!state.dirty&&!keepLocal) || (state.status==="conflict"&&!keepLocal))return;
      saving=true;const at=generation;const data=structuredClone(state.data);
      update({...state,status:"saving",error:undefined});
      try {
        const receipt=await transport.write(keepLocal&&remote?remote.revision:state.revision,data);
        if(disposed)return;
        observedVersion=sourceVersion;
        update({...state,revision:receipt.revision,dirty:generation!==at,status:generation===at?"synced":"local",error:undefined});
      }catch(error){if(!disposed)update({...state,status:"conflict",error:String(error)});}
      finally{saving=false;}
    },
    useRemote(){if(remote){observedVersion=sourceVersion;generation++;update({...state,data:remote.data??initial,revision:remote.revision,dirty:!!remote.stale,loaded:true,status:remote.stale?"local":"synced",error:undefined});}},
    dispose(){disposed=true;},
  };
}

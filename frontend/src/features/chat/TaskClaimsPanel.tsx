import { useCallback, useEffect, useState } from "react";
import { Bot, Check, X } from "lucide-react";
import toast from "react-hot-toast";
import { listTaskClaims, resolveTaskClaim, type TaskClaim } from "@/api/taskClaims";
import { Button } from "@/components/ui/button";

export function TaskClaimsPanel({channelId,canManage,refreshKey=0}:{channelId:string;canManage:boolean;refreshKey?:number}) {
  const [claims,setClaims]=useState<TaskClaim[]>([]); const [busy,setBusy]=useState("");
  const refresh=useCallback(()=>listTaskClaims(channelId,"pending").then(setClaims).catch(()=>{}),[channelId]);
  useEffect(()=>{void refresh();const timer=window.setInterval(()=>void refresh(),10000);return()=>window.clearInterval(timer)},[refresh]);
  useEffect(()=>{void refresh()},[refresh,refreshKey]);
  if(!claims.length)return null;
  const resolve=async(c:TaskClaim,decision:"accept"|"reject")=>{setBusy(c.claim_id);try{await resolveTaskClaim(channelId,c.claim_id,decision);setClaims(v=>v.filter(x=>x.claim_id!==c.claim_id));toast.success(decision==="accept"?`${c.bot_name} started the task`:"Claim rejected")}catch(e){toast.error(e instanceof Error?e.message:"Could not resolve claim");await refresh()}finally{setBusy("")}};
  return <div className="mx-4 mb-2 max-h-56 space-y-2 overflow-y-auto rounded-xl border border-indigo-500/25 bg-indigo-500/5 p-3"><p className="text-xs font-semibold uppercase tracking-wide text-indigo-300">Task claim requests · {claims.length}</p>{claims.map(c=><div key={c.claim_id} className="rounded-lg border border-zinc-800 bg-zinc-900/90 p-3"><div className="flex items-start gap-2"><Bot className="mt-0.5 h-4 w-4 text-indigo-400"/><div className="min-w-0 flex-1"><p className="text-sm font-medium text-zinc-100">{c.bot_name}: {c.summary}</p><p className="mt-1 text-xs text-zinc-400">{c.proposed_action}</p><p className="mt-1 text-[11px] text-zinc-500">{Math.round(c.confidence*100)}% confidence · {c.impact} impact</p></div></div>{canManage&&<div className="mt-2 flex justify-end gap-2"><Button size="sm" variant="secondary" disabled={busy===c.claim_id} onClick={()=>void resolve(c,"reject")}><X className="h-3.5 w-3.5"/>Reject</Button><Button size="sm" loading={busy===c.claim_id} onClick={()=>void resolve(c,"accept")}><Check className="h-3.5 w-3.5"/>Approve & run</Button></div>}</div>)}</div>;
}

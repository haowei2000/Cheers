import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Bot, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getBotMonitoring, updateBotMonitoring, type BotMonitoring } from "@/api/taskClaims";
import type { MemberItem } from "@/types";

const defaults: Omit<BotMonitoring,"channel_id"|"bot_id"> = { mode:"off",scope:"",debounce_seconds:15,min_interval_seconds:60,max_evaluations_per_hour:20,batch_size:8,confidence_threshold:0.75 };
export function TaskClaimSettings({channelId,bots}:{channelId:string;bots:MemberItem[]}) {
  const [selected,setSelected]=useState(""); const [policy,setPolicy]=useState(defaults); const [saving,setSaving]=useState(false);
  useEffect(()=>{if(!selected&&bots[0])setSelected(bots[0].member_id)},[bots,selected]);
  useEffect(()=>{if(selected)getBotMonitoring(channelId,selected).then(({channel_id:_,bot_id:__,...p})=>setPolicy(p)).catch(()=>setPolicy(defaults))},[channelId,selected]);
  if(!bots.length)return null;
  const save=async()=>{setSaving(true);try{const {channel_id:_,bot_id:__,...p}=await updateBotMonitoring(channelId,selected,policy);setPolicy(p);toast.success("Task monitoring saved")}catch(e){toast.error(e instanceof Error?e.message:"Failed to save monitoring")}finally{setSaving(false)}};
  return <div className="space-y-3 border-t border-zinc-800 pt-4">
    <div className="flex items-center gap-2"><Radio className="h-4 w-4 text-indigo-400"/><div><p className="text-sm font-medium text-zinc-200">Proactive task claiming</p><p className="text-xs text-zinc-400">A bot can inspect activity and ask before starting work.</p></div></div>
    <select value={selected} onChange={e=>setSelected(e.target.value)} className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200">{bots.map(b=><option key={b.member_id} value={b.member_id}>{b.display_name||b.username||b.member_id.slice(0,8)}</option>)}</select>
    <div className="grid grid-cols-2 gap-2">
      <label className="text-xs text-zinc-400">Listen to<select value={policy.mode} onChange={e=>setPolicy({...policy,mode:e.target.value as BotMonitoring["mode"]})} className="mt-1 w-full rounded bg-zinc-800 px-2 py-2 text-zinc-200"><option value="off">Off</option><option value="text">Text messages</option><option value="text_and_transcript">Text + voice transcript</option><option value="all_activity">All activity</option></select></label>
      <label className="text-xs text-zinc-400">Debounce (seconds)<input type="number" min={1} max={3600} value={policy.debounce_seconds} onChange={e=>setPolicy({...policy,debounce_seconds:Number(e.target.value)})} className="mt-1 w-full rounded bg-zinc-800 px-2 py-2 text-zinc-200"/></label>
      <label className="text-xs text-zinc-400">Minimum interval<input type="number" min={1} value={policy.min_interval_seconds} onChange={e=>setPolicy({...policy,min_interval_seconds:Number(e.target.value)})} className="mt-1 w-full rounded bg-zinc-800 px-2 py-2 text-zinc-200"/></label>
      <label className="text-xs text-zinc-400">Checks per hour<input type="number" min={1} max={1000} value={policy.max_evaluations_per_hour} onChange={e=>setPolicy({...policy,max_evaluations_per_hour:Number(e.target.value)})} className="mt-1 w-full rounded bg-zinc-800 px-2 py-2 text-zinc-200"/></label>
    </div>
    <label className="block text-xs text-zinc-400">Bot responsibility scope<textarea rows={3} value={policy.scope} placeholder="Example: frontend implementation, UI bugs, and accessibility" onChange={e=>setPolicy({...policy,scope:e.target.value})} className="mt-1 w-full resize-none rounded bg-zinc-800 px-3 py-2 text-sm text-zinc-200"/></label>
    <div className="flex items-center justify-between"><span className="flex items-center gap-1 text-[11px] text-zinc-500"><Bot className="h-3 w-3"/>Human approval is always required.</span><Button size="sm" loading={saving} onClick={()=>void save()}>Save monitoring</Button></div>
  </div>;
}

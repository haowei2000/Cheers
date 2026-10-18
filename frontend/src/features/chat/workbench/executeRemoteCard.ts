import { confirmRemoteExecution } from "./confirmRemoteExecution";
import { resolveDeskResource } from "@/api/resources";
import { getWorkspaceMeta,listWorkspaceBots } from "@/api/workspace";
import { startRemoteExecution } from "@/api/remoteExecutions";
import type { ResourceInteraction } from "./interaction";

/** The host obtains the actual device, shows approval, then submits a declared action. */
export async function executeRemoteCard(event:ResourceInteraction,channelId:string) {
  const source=await resolveDeskResource(event.sourceUri,channelId);
  const bots=await listWorkspaceBots(source.channel_id);
  const bot=bots.find(bot=>bot.bot_id===event.botId);
  if(!bot?.host_id||!bot.can_execute)throw new Error("Only the Bot owner or an administrator can execute on its active device.");
  const input=event.input;
  if(input.action!=="terminal.start"&&input.action!=="file.open")throw new Error("Unsupported remote operation.");
  const meta=await getWorkspaceMeta(source.channel_id,event.botId);
  if(input.action==="terminal.start"&&!meta.remote_terminal)throw new Error("Enable remote_terminal on this connector before executing commands.");
  if(input.action==="file.open"&&!meta.remote_open)throw new Error("Enable remote_open on this connector before opening files.");
  const path=typeof input.path==="string"?input.path:"";
  const root=typeof input.root==="string"?input.root:null;
  const command=typeof input.command==="string"?input.command:null;
  const opener=typeof input.opener==="string"?input.opener:null;
  if(!await confirmRemoteExecution(bot.host_name??bot.username,`${root??meta.default_cwd??"registered root"}/${path}`,command??opener??"Interactive terminal"))throw new Error("Execution cancelled before sending.");
  const receipt=await startRemoteExecution(source.channel_id,{bot_id:event.botId,host_id:bot.host_id,invocation_id:event.invocationId,
    action:String(input.action),path,root,command,opener,source_event:event});
  return {executionId:receipt.execution_id};
}

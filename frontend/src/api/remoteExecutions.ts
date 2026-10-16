import { apiJson } from "./client";
import type { ResourceInteraction } from "@/features/chat/workbench/interaction";
export interface ExecutionReceipt {
  execution_id:string;status:"accepted"|"running"|"succeeded"|"failed"|"cancelled"|"unknown";
  result?:{output_b64?:string;offset?:number;next_offset?:number;truncated?:boolean;exit_code?:number;error?:string;message?:string};
}
export function startRemoteExecution(channelId:string,input:{bot_id:string;host_id:string;invocation_id:string;action:string;path?:string;root?:string|null;command?:string|null;opener?:string|null;source_event?:ResourceInteraction}):Promise<ExecutionReceipt> {
  return apiJson(`/channels/${channelId}/remote-executions`,{method:"POST",body:JSON.stringify(input)},{recentAuth:"auto",actionClass:"remote_execution"});
}
export function controlRemoteExecution(id:string,action:string,extra:{input?:string;offset?:number;cols?:number;rows?:number}={}):Promise<ExecutionReceipt> {
  return apiJson(`/resources/executions/${id}`,{method:"POST",body:JSON.stringify({action,...extra})},action==="terminal.input"||action==="terminal.cancel"?{recentAuth:"auto",actionClass:"remote_execution"}:undefined);
}

export function listRemoteExecutions(channelId:string,botId:string):Promise<{executions:Array<{execution_id:string;status:ExecutionReceipt["status"];command:string|null;created_at:string}>}> {
  return apiJson(`/resources/executions?${new URLSearchParams({channel_id:channelId,bot_id:botId})}`);
}

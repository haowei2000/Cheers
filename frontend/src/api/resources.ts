import { apiJson } from "./client";
export interface ResolvedDeskResource {
  kind:"desk";
  uri:string; resource_id:string; service_id:string; channel_id:string; path:string;
  content:string; version:number; latest_version:number; is_dir:boolean; deleted:boolean;
}
export type ResolvedResource=ResolvedDeskResource|{kind:"inbox"|"msg"|"plan"|"sessions"|"cost"|"activity";uri:string;resource_id:string;service_id:string;channel_id:string};
export async function resolveDeskResource(uri:string,channelId?:string):Promise<ResolvedDeskResource> {
  const resource=await resolveResource(uri,channelId);
  if(resource.kind!=="desk")throw new Error("A Desk resource is required");
  return resource;
}
export function resolveResource(uri:string,channelId?:string):Promise<ResolvedResource> {
  return apiJson("/resources/resolve",{method:"POST",body:JSON.stringify({uri,channel_id:channelId})});
}
export interface DraftSnapshot { revision:number; source_version:number; data:Record<string,unknown>|null; stale?:boolean }
export interface DraftKey { uri:string; view_id:string; schema_version:number }
export function readResourceDraft(key:DraftKey):Promise<DraftSnapshot> {
  return apiJson(`/resources/draft?${new URLSearchParams({uri:key.uri,view_id:key.view_id,schema_version:String(key.schema_version)})}`);
}
export function writeResourceDraft(key:DraftKey,sourceVersion:number,revision:number,data:Record<string,unknown>):Promise<DraftSnapshot> {
  return apiJson("/resources/draft",{method:"PUT",body:JSON.stringify({...key,source_version:sourceVersion,if_revision:revision,data})});
}

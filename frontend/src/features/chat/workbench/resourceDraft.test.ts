import { describe,expect,it,vi } from "vitest";
import { createResourceDraft } from "./resourceDraft";
import type { DraftSnapshot } from "@/api/resources";
function transport(initial:DraftSnapshot={data:{topic:"cloud"},revision:1,source_version:1}) {
  return {read:vi.fn().mockResolvedValue(initial),write:vi.fn().mockResolvedValue({revision:2,source_version:1}),loadLocal:()=>null,saveLocal:vi.fn()};
}
describe("resource draft synchronization",()=>{
  it("restores the cloud copy and saves with its observed revision",async()=>{
    const io=transport();const draft=createResourceDraft({},1,io,vi.fn());await draft.refresh();
    expect(draft.snapshot().data).toEqual({topic:"cloud"});draft.edit({topic:"local"});await draft.save();
    expect(io.write).toHaveBeenCalledWith(1,{topic:"local"});expect(draft.snapshot().dirty).toBe(false);
  });
  it("does not overwrite edits with another device's changes",async()=>{
    const io=transport();const draft=createResourceDraft({},1,io,vi.fn());await draft.refresh();draft.edit({topic:"local"});
    io.read.mockResolvedValue({data:{topic:"other device"},revision:2,source_version:1});await draft.refresh();await draft.save();
    expect(draft.snapshot()).toMatchObject({data:{topic:"local"},status:"conflict"});expect(io.write).not.toHaveBeenCalled();
    await draft.save(true);expect(io.write).toHaveBeenCalledWith(2,{topic:"local"});
  });
  it("preserves edits made while a save is in flight",async()=>{
    const io=transport();let finish!:(v:DraftSnapshot)=>void;io.write.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const draft=createResourceDraft({},1,io,vi.fn());await draft.refresh();draft.edit({topic:"first"});const save=draft.save();draft.edit({topic:"second"});finish({revision:2,source_version:1,data:null});await save;
    expect(draft.snapshot()).toMatchObject({data:{topic:"second"},dirty:true,revision:2});
  });
  it("keeps offline edits and records their old source until explicitly reviewed",async()=>{
    const io={...transport({data:null,revision:0,source_version:2}),loadLocal:()=>({data:{topic:"old source"},revision:0,sourceVersion:1,dirty:true})};
    const draft=createResourceDraft({},2,io,vi.fn());await draft.refresh();await draft.save();
    expect(draft.snapshot().status).toBe("conflict");expect(io.write).not.toHaveBeenCalled();
    expect(io.saveLocal.mock.lastCall?.[3]).toBe(1);
    await draft.save(true);expect(io.saveLocal.mock.lastCall?.[3]).toBe(2);
  });
  it("blocks saving before remote revision is known and handles offline reads",async()=>{
    const io=transport();io.read.mockRejectedValue(new Error("offline"));const draft=createResourceDraft({},1,io,vi.fn());draft.edit({topic:"local"});await draft.refresh();await draft.save();
    expect(draft.snapshot()).toMatchObject({data:{topic:"local"},status:"offline"});expect(io.write).not.toHaveBeenCalled();
  });
});

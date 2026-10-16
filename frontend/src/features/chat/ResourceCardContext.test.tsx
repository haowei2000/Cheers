import { useContext } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect,it,vi } from "vitest";
import { ResourceCardContext,ResourceCardProvider } from "./ResourceCardContext";
import { makeFsClient } from "./workbench/fsClient";
import { fileResourceStore } from "./workbench/fileResource";
it("loads an inline file before the channel has received its first files signal",async()=>{
  const fs=makeFsClient(vi.fn(),"channel");
  fs.read=vi.fn().mockResolvedValue({path:"form.json",content:"{}",version:1,is_dir:false});
  let firstRead:Promise<unknown>|undefined;
  function Preview(){const host=useContext(ResourceCardContext)!;firstRead=fileResourceStore(host.fs).refresh("form.json",host.filesTick);return null;}
  renderToStaticMarkup(<ResourceCardProvider fs={fs} channelId="channel" filesTick={undefined as unknown as number} openLocator={()=>{}} composeMessage={()=>{}}><Preview/></ResourceCardProvider>);
  await firstRead;
  expect(fs.read).toHaveBeenCalledWith("form.json");
  expect(fileResourceStore(fs).snapshot("form.json").file?.version).toBe(1);
});

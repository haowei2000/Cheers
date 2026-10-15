import { createRoot } from "react-dom/client";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
let pending=false;
/** Host-owned approval works identically in WKWebView and browsers. */
export function confirmRemoteExecution(device:string,directory:string,operation:string):Promise<boolean> {
  if(pending)return Promise.resolve(false);
  pending=true;
  const element=document.createElement("div");document.body.appendChild(element);
  const root=createRoot(element);
  return new Promise(resolve=>{
    let settled=false;
    const finish=(approved:boolean)=>{
      if(settled)return;settled=true;pending=false;
      resolve(approved);queueMicrotask(()=>{root.unmount();element.remove();});
    };
    root.render(<Dialog title="Confirm remote execution" onClose={()=>finish(false)} maxWidth="max-w-lg">
      <p className="text-body">Device: {device}</p>
      <p className="break-words text-body-secondary">Directory: {directory}</p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-code text-regular">{operation}</pre>
      <p className="text-body-secondary">This runs with the device account's permissions. The starting directory does not sandbox shell commands.</p>
      <div className="flex justify-end gap-2">
        <Button action="cancel" controlSize="compact" onClick={()=>finish(false)} />
        <Button action="request" controlSize="compact" onClick={event=>{if(event.nativeEvent.isTrusted)finish(true);}} />
      </div>
    </Dialog>);
  });
}

import { useEffect,useRef,useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { controlRemoteExecution,startRemoteExecution,listRemoteExecutions,type ExecutionReceipt } from "@/api/remoteExecutions";
import { getWorkspaceMeta,listWorkspaceBots,type WorkspaceBot,type WorkspaceMeta } from "@/api/workspace";
import { Button } from "@/components/ui/button";
import { ActionButton } from "@/components/ui/action-button";
import { Input } from "@/components/ui/input";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { Terminal as TerminalIcon } from "lucide-react";
import { Field } from "@/components/ui/field";

export function ExecutionTerminal({executionId}:{executionId:string}) {
  const container=useRef<HTMLDivElement>(null);
  const [receipt,setReceipt]=useState<ExecutionReceipt>();
  const [error,setError]=useState("");
  useEffect(()=>{
    if(!container.current)return;
    const terminal=new Terminal({fontSize:Number.parseFloat(getComputedStyle(container.current).fontSize),scrollback:2000,convertEol:false,allowProposedApi:false,screenReaderMode:true,disableStdin:true});
    const fit=new FitAddon();terminal.loadAddon(fit);terminal.open(container.current);fit.fit();
    let closed=false;let offset=0;let polling=false;
    // Serialize keyboard writes; a network failure stops sending subsequent input.
    let inputQueue=Promise.resolve();let inputStopped=false;
    const input=terminal.onData(data=>{inputQueue=inputQueue.then(async()=>{if(closed||inputStopped)return;try{await controlRemoteExecution(executionId,"terminal.input",{input:data});}catch(error){inputStopped=true;setError(String(error));}});});
    const observer=new ResizeObserver(()=>{fit.fit();void controlRemoteExecution(executionId,"terminal.resize",{cols:terminal.cols,rows:terminal.rows}).catch(e=>{if(!closed)setError(String(e));});});observer.observe(container.current);
    const poll=async()=>{
      if(closed||polling)return;polling=true;
      try {
        const next=await controlRemoteExecution(executionId,"terminal.status",{offset});if(closed)return;
        if(next.result?.truncated)terminal.writeln("\r\nEarlier output was truncated on the host.\r\n");
        if(next.result?.output_b64)terminal.write(Uint8Array.from(atob(next.result.output_b64),c=>c.charCodeAt(0)));
        offset=Math.max(offset,next.result?.next_offset??offset);terminal.options.disableStdin=next.status!=="running";setReceipt(next);setError(next.result?.error??"");
        if(["succeeded","failed","cancelled","unknown"].includes(next.status)){clearInterval(timer);inputStopped=true;}
      }catch(error){if(!closed){terminal.options.disableStdin=true;setError(String(error));}}finally{polling=false;}
    };
    const timer=setInterval(()=>void poll(),750);void poll();
    return()=>{closed=true;clearInterval(timer);observer.disconnect();input.dispose();terminal.dispose();};
  },[executionId]);
  return <section className="space-y-2" aria-label="Remote terminal execution">
    <div ref={container} className="h-64 min-w-0 overflow-hidden text-regular" />
    <p role="status" className="text-body-secondary">{receipt?.status??"Connecting…"}{typeof receipt?.result?.exit_code==="number"?` · Exit ${receipt.result.exit_code}`:""}</p>
    {error&&<p role="alert" className="text-body-error">{error}</p>}
    {receipt&&(receipt.status==="running"||receipt.status==="accepted")&&<Button action="stop" controlSize="compact" onClick={()=>{void controlRemoteExecution(executionId,"terminal.cancel").then(setReceipt).catch(e=>setError(String(e)));}} />}
  </section>;
}

/** A compact reply opens the same terminal outside the clipped Canvas viewport. */
export function ExecutionLink({executionId}:{executionId:string}) {
  const [open,setOpen]=useState(false);
  return <><ActionButton action="open" context="resourceCard" controlSize="compact" onClick={()=>setOpen(true)} accessibleLabel="Open execution terminal" />
    {open&&<FloatingPanel title="Execution terminal" icon={TerminalIcon} storageKey="cheers.float.execution" viewport onClose={()=>setOpen(false)}><ExecutionTerminal executionId={executionId}/></FloatingPanel>}
  </>;
}

export function RemoteTerminal({channelId,botId,path="",root}:{channelId:string;botId:string;path?:string;root?:string|null}) {
  const [bot,setBot]=useState<WorkspaceBot>();const [meta,setMeta]=useState<WorkspaceMeta>();
  const [command,setCommand]=useState("");const [id,setId]=useState("");const [error,setError]=useState("");const [busy,setBusy]=useState(false);
  const invocation=useRef(crypto.randomUUID());
  const [history,setHistory]=useState<Awaited<ReturnType<typeof listRemoteExecutions>>["executions"]>([]);
  useEffect(()=>{let active=true;listRemoteExecutions(channelId,botId).then(value=>{if(active)setHistory(value.executions);}).catch(e=>{if(active)setError(String(e));});return()=>{active=false;};},[channelId,botId]);
  useEffect(()=>{let active=true;Promise.all([listWorkspaceBots(channelId),getWorkspaceMeta(channelId,botId)]).then(([bots,meta])=>{if(active){setBot(bots.find(b=>b.bot_id===botId));setMeta(meta);}}).catch(e=>{if(active)setError(String(e));});return()=>{active=false;};},[channelId,botId]);
  if(id)return <ExecutionTerminal executionId={id}/>;
  return <section className="space-y-4 p-4" aria-label="Open a remote terminal">
    <p className="text-body">Device: {bot?.host_name??"Loading…"} · Directory: {root??meta?.default_cwd??"registered root"}/{path}</p>
    <p className="text-body-secondary">Commands run with the device account's permissions.</p>
    <Field label="Command (leave empty for an interactive shell)" htmlFor="remote-terminal-command"><Input id="remote-terminal-command" value={command} onChange={event=>{setCommand(event.target.value);invocation.current=crypto.randomUUID();}}/></Field>
    <Button action="request" disabled={!bot?.host_id||!bot.can_execute||!meta?.remote_terminal||busy} loading={busy} onClick={async(event)=>{
      if(!event.nativeEvent.isTrusted||!bot?.host_id)return;setBusy(true);
      try{const receipt=await startRemoteExecution(channelId,{bot_id:botId,host_id:bot.host_id,invocation_id:invocation.current,action:"terminal.start",path,root:root??null,command:command||null});setId(receipt.execution_id);}catch(e){setError(String(e));}finally{setBusy(false);}
    }}/>
    {history.length>0&&<div className="space-y-2"><p className="text-body-secondary">Recent executions</p>{history.map(item=><div key={item.execution_id} className="flex items-center gap-2"><Button action="open" controlSize="compact" onClick={()=>setId(item.execution_id)} aria-label={`Open ${item.command??"interactive shell"}`} /><span className="text-body-secondary">{item.command??"Interactive shell"} · {item.status}</span></div>)}</div>}
    {meta&&!meta.remote_terminal&&<p className="text-body-secondary">Enable remote_terminal on this device's connector to use the terminal.</p>}
    {error&&<p role="alert" className="text-body-error">{error}</p>}
  </section>;
}

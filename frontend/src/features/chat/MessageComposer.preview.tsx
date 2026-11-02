import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/components/ui/theme";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { clearClientSessionData } from "@/lib/clientSession";
import { MessageComposer, type ComposerPrefill, type MentionCandidate } from "./MessageComposer";
import "@/index.css";

const mentionables: MentionCandidate[] = [
  { id: "bot-ada", type: "bot", label: "Ada Bot", isOnline: true },
  { id: "bot-short", type: "bot", label: "Ada", isOnline: true },
  { id: "user-lin", type: "user", label: "Lin" },
];
const preview = {
  mode: "success" as "success" | "failure" | "pending",
  sent: [] as { channel: string; content: string; ids: string[]; names: string[] }[],
  resolve: () => {}, reject: () => {},
  switchChannel: (_channel: string) => {},
  prefill: (_value: ComposerPrefill) => {},
  pinSession: (_pinned: boolean) => {},
  streaming: (_count: number) => {},
  clearSession: clearClientSessionData,
};
Object.assign(window, { composerPreview: preview });

function Preview() {
  const [channel, setChannel] = useState("preview-a");
  const [prefill, setPrefill] = useState<ComposerPrefill | null>(null);
  const [pinned, setPinned] = useState(false);
  const [streaming, setStreaming] = useState(0);
  preview.switchChannel = setChannel;
  preview.prefill = setPrefill;
  preview.pinSession = setPinned;
  preview.streaming = setStreaming;
  return <main className="min-h-screen bg-canvas p-4 text-content-primary">
    <div role="tablist" aria-label="Preview channels" className="mb-4 flex gap-2">
      {["preview-a", "preview-b"].map(id => <ControlTrigger key={id} role="tab" aria-selected={id === channel} selected={id === channel} onClick={() => setChannel(id)}>{id}</ControlTrigger>)}
    </div>
    <MessageComposer
      channelId={channel}
      channelName={channel}
      sessionTargetName={pinned ? "Ada Bot" : undefined}
      mentionables={mentionables}
      prefill={prefill}
      streamingCount={streaming}
      onStopStreaming={() => setStreaming(0)}
      onSend={async (content, ids, _files, names) => {
        preview.sent.push({ channel, content, ids, names });
        if (preview.mode === "failure") throw new Error("Preview send failed");
        if (preview.mode === "pending") await new Promise<void>((resolve, reject) => {
          preview.resolve = resolve;
          preview.reject = () => reject(new Error("Preview send failed"));
        });
      }}
    />
  </main>;
}
createRoot(document.getElementById("root")!).render(<ThemeProvider><Preview /></ThemeProvider>);

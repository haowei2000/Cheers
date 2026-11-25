import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/components/ui/theme";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { clearClientSessionData } from "@/lib/clientSession";
import { MessageComposer, type ComposerPrefill, type MentionCandidate } from "./MessageComposer";
import { contentWithReplyQuote, type ReplyTarget } from "./replyDraft";
import { ContextActionsProvider, useContextSurface } from "@/components/ui/context-actions";
import "@/index.css";

const mentionables: MentionCandidate[] = [
  { id: "bot-ada", type: "bot", label: "Ada Bot", isOnline: true },
  { id: "bot-short", type: "bot", label: "Ada", isOnline: true },
  { id: "user-lin", type: "user", label: "Lin" },
];
const sourceMessage = {
  msg_id: "preview-source", sender_id: "user-lin", sender_type: "user" as const,
  sender_name: "Lin", content: "你好，我在！今天想聊什么？\n意思是：“你在想什么？”也可以自然地表示“你想聊些什么？”",
};
const preview = {
  mode: "success" as "success" | "failure" | "pending",
  sent: [] as { channel: string; content: string; ids: string[]; names: string[] }[],
  resolve: () => {}, reject: () => {},
  switchChannel: (_channel: string) => {},
  prefill: (_value: ComposerPrefill) => {},
  pinSession: (_pinned: boolean) => {},
  streaming: (_count: number) => {},
  reply: (_target: ReplyTarget | null) => {},
  clearSession: clearClientSessionData,
};
Object.assign(window, { composerPreview: preview });

function Preview() {
  const [channel, setChannel] = useState("preview-a");
  const [prefill, setPrefill] = useState<ComposerPrefill | null>(null);
  const [pinned, setPinned] = useState(false);
  const [streaming, setStreaming] = useState(0);
  const [reply, setReply] = useState<ReplyTarget | null>(null);
  const sourceRef = useRef<HTMLElement>(null);
  const surface = useContextSurface({
    surfaceRef: sourceRef,
    actions: () => [{ id: "reply", label: "Reply", restoreFocus: false, run: () => setReply({ message: sourceMessage }) }],
    selectionActions: selection => [{
      id: "reply-with-quote", label: "Reply with quote",
      restoreFocus: false,
      run: () => setReply({ message: sourceMessage, quote: selection.text.trim() }),
    }],
  });
  preview.switchChannel = (next) => { setChannel(next); setReply(null); };
  preview.prefill = setPrefill;
  preview.pinSession = setPinned;
  preview.streaming = setStreaming;
  preview.reply = setReply;
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setReply(null);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);
  return <main className="min-h-screen bg-canvas p-4 text-content-primary">
    <div role="tablist" aria-label="Preview channels" className="mb-4 flex gap-2">
      {["preview-a", "preview-b"].map(id => <ControlTrigger key={id} role="tab" aria-selected={id === channel} selected={id === channel} onClick={() => preview.switchChannel(id)}>{id}</ControlTrigger>)}
    </div>
    <article ref={sourceRef} {...surface}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- This sample message exposes keyboard context-menu actions, matching MessageItem.
      tabIndex={0} aria-label="Source message" className="mx-auto mb-4 max-w-6xl whitespace-pre-wrap p-4 font-reading text-regular focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-content-strong/50">{sourceMessage.content}</article>
    <MessageComposer
      reply={reply ? { target: reply, onCancel: () => setReply(null) } : undefined}
      channelId={channel}
      channelName={channel}
      sessionTargetName={pinned ? "Ada Bot" : undefined}
      mentionables={mentionables}
      prefill={prefill}
      streamingCount={streaming}
      onStopStreaming={() => setStreaming(0)}
      onSend={async (content, ids, _files, names) => {
        preview.sent.push({ channel, content: contentWithReplyQuote(content, reply?.quote), ids, names });
        if (preview.mode === "failure") throw new Error("Preview send failed");
        if (preview.mode === "pending") await new Promise<void>((resolve, reject) => {
          preview.resolve = resolve;
          preview.reject = () => reject(new Error("Preview send failed"));
        });
        setReply(current => current === reply ? null : current);
      }}
    />
  </main>;
}
createRoot(document.getElementById("root")!).render(<ThemeProvider><ContextActionsProvider><Preview /></ContextActionsProvider></ThemeProvider>);

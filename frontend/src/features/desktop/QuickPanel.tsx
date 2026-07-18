import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Send, Zap } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { listDms } from "@/api/channels";
import { sendMessage } from "@/api/messages";
import { useAuthStore } from "@/stores/authStore";
import type { Channel } from "@/types";

/** Hide the Spotlight-style quick-panel window (Esc / after send). Blur also
 * hides it (handled in Rust on_window_event); this is the explicit path. No-op
 * outside the desktop shell. */
async function hidePanel(): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().hide();
  } catch {
    // Not in the desktop shell (or the window's already gone) — nothing to do.
  }
}

/** Compact composer rendered in its own always-on-top window (index.html?
 * quickpanel=1, summoned by ⌥⌘K). Pick a bot/DM, type a task, send it through
 * the SAME gateway post-message API the main composer uses — the control plane
 * still owns delivery and every permission decision. Shares localStorage with
 * the main window, so it authenticates with no extra wiring. */
export function QuickPanel() {
  const user = useAuthStore((s) => s.user);
  const [dms, setDms] = useState<Channel[] | null>(null);
  const [target, setTarget] = useState<string>("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    listDms()
      .then((list) => {
        if (!alive) return;
        setDms(list);
        setTarget((prev) => prev || list[0]?.channel_id || "");
      })
      .catch(() => alive && setDms([]));
    return () => {
      alive = false;
    };
  }, [user]);

  // Focus the message field on summon so the user can type immediately.
  useEffect(() => {
    textareaRef.current?.focus();
  }, [dms]);

  const send = useCallback(async () => {
    const body = text.trim();
    if (!target || !body || sending) return;
    setSending(true);
    try {
      await sendMessage(target, body);
      setText("");
      await hidePanel();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send — try again");
    } finally {
      setSending(false);
    }
  }, [target, text, sending]);

  // Esc dismisses the panel from anywhere inside it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void hidePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const peerName = useMemo(
    () => (c: Channel) => c.peer_name || c.name || "Direct message",
    []
  );

  return (
    <div className="h-screen w-screen bg-zinc-900 text-zinc-100 flex flex-col overflow-hidden">
      {/* Frameless window: this strip is the drag handle. */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 px-4 h-10 shrink-0 border-b border-zinc-800 select-none"
      >
        <Zap className="w-4 h-4 text-indigo-400" />
        <span className="text-xs font-medium text-zinc-300">Quick send</span>
        <span className="ml-auto text-[10px] text-zinc-600">Esc to dismiss</span>
      </div>

      {!user ? (
        <div className="flex-1 flex items-center justify-center p-6 text-center">
          <p className="text-sm text-zinc-400">
            Sign in from the main Cheers window first, then reopen this panel.
          </p>
        </div>
      ) : dms === null ? (
        <div className="flex-1 flex items-center justify-center">
          <Spinner size={20} className="text-zinc-600" />
        </div>
      ) : dms.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-6 text-center">
          <p className="text-sm text-zinc-400">
            No direct messages yet. Start a DM with a bot in the main window, then
            quick-send here.
          </p>
        </div>
      ) : (
        <div className="flex-1 flex flex-col gap-3 p-4 min-h-0">
          <Select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            aria-label="Send to"
          >
            {dms.map((c) => (
              <option key={c.channel_id} value={c.channel_id}>
                {peerName(c)}
              </option>
            ))}
          </Select>
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter (or IME composition) inserts a newline.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Type a message or task…"
            className="flex-1 resize-none min-h-0"
          />
          <div className="flex items-center justify-end">
            <Button
              onClick={() => void send()}
              disabled={!target || !text.trim()}
              loading={sending}
            >
              <Send className="w-4 h-4" /> Send
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default QuickPanel;

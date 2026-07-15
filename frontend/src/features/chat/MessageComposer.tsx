import {
  memo,
  useState,
  useRef,
  useCallback,
  useMemo,
  useEffect,
  type KeyboardEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  SendHorizontal,
  Bot,
  User,
  Paperclip,
  X,
  FileText,
  Upload,
  FolderOpen,
  AudioLines,
  Loader2,
  Square,
  SquareSlash,
} from "lucide-react";
import toast from "react-hot-toast";
import { cn } from "@/lib/cn";
import { uploadFile, transcribeFile, getFileStatus } from "@/api/files";
import type { FileInfo } from "@/types";
import { isAudioFile } from "./fileUtils";
import { CommandPalette, type CommandCandidate } from "./CommandPalette";
import { ExistingFilePicker } from "./ExistingFilePicker";
import { usePopoverDismiss, PopoverPanel } from "@/components/ui/popover";

export type { CommandCandidate } from "./CommandPalette";

export interface MentionCandidate {
  id: string;
  /** "group" = a group token (@all/@bots/…) sent as a mention_name, not an id. */
  type: "user" | "bot" | "group";
  label: string;
  sublabel?: string;
  /** Bots: whether the agent accepts audio prompts (unknown → false, fail-safe). */
  canReceiveAudio?: boolean;
}

// Group @-mention tokens the server expands to real members (findings 3a). Their
// `id` IS the token sent in `mention_names`; the label drives the "@label" text.
// `@here` currently aliases `@all` (no write-time presence signal yet).
const GROUP_MENTIONS: MentionCandidate[] = [
  { id: "all", type: "group", label: "all", sublabel: "Everyone in the channel" },
  { id: "bots", type: "group", label: "bots", sublabel: "All bots — triggers each" },
  { id: "humans", type: "group", label: "humans", sublabel: "All people" },
  { id: "here", type: "group", label: "here", sublabel: "Everyone (currently same as @all)" },
];

// Picker ordering: bots (primary @target) → group tokens → people.
const mentionRank = (c: MentionCandidate): number =>
  c.type === "bot" ? 0 : c.type === "group" ? 1 : 2;

interface Props {
  channelId?: string;
  channelName?: string;
  disabled?: boolean;
  mentionables?: MentionCandidate[];
  /** Slash-commands advertised by the channel's bots (⑦ command palette). */
  commands?: CommandCandidate[];
  /** Optional controls rendered in the card's controls row, between the attach
      button and the send button (session chip, model chip, …). */
  toolbar?: ReactNode;
  /** Fires with the bots currently @mentioned in the draft (token still present),
      so the parent can surface per-bot controls contextual to the mention. */
  onMentionsChange?: (mentionedBots: MentionCandidate[]) => void;
  /** Fires with the raw draft text on change, so the parent can derive suggested
      context (F3 — e.g. a filename mentioned in the draft). */
  onTextChange?: (text: string) => void;
  /** Bot turns currently streaming in the channel. With an empty draft the send
      button morphs into Stop; a typed draft always keeps Send (concurrent sends
      are legal in a channel chat). */
  streamingCount?: number;
  /** Stop every in-flight bot turn (each stop also halts its bot@bot chain). */
  onStopStreaming?: () => Promise<void> | void;
  onSend: (
    content: string,
    mentionIds: string[],
    fileIds: string[],
    mentionNames: string[]
  ) => Promise<void>;
}

// The composer runs one picker at a time, opened by either "@" (mention) or "/"
// (command). `kind` says which list to filter and how a selection is inserted.
interface PickerState {
  kind: "mention" | "command";
  /** index into `text` of the active trigger char ("@" or "/") */
  at: number;
  query: string;
  index: number;
}

// Per-channel draft stash. One composer instance survives channel switches, so
// without this a half-typed draft — and worse, channel A's uploaded attachments —
// leaks into channel B. In-memory for the tab's lifetime; `text` additionally
// mirrors into sessionStorage so a reload doesn't eat a half-typed message
// (attachments/mentions stay memory-only — file metadata isn't trusted across
// reloads).
interface DraftState {
  text: string;
  attachments: FileInfo[];
  picked: MentionCandidate[];
  transcribedIds: Set<string>;
}
const draftsByChannel = new Map<string, DraftState>();
const draftKey = (channelId: string) => `cheers.draft.${channelId}`;

function stashDraft(channelId: string, d: DraftState) {
  if (d.text || d.attachments.length) draftsByChannel.set(channelId, d);
  else draftsByChannel.delete(channelId);
}

function restoredText(channelId?: string): string {
  if (!channelId) return "";
  const mem = draftsByChannel.get(channelId);
  if (mem) return mem.text;
  try {
    return sessionStorage.getItem(draftKey(channelId)) ?? "";
  } catch {
    return "";
  }
}

function MessageComposerImpl({
  channelId,
  channelName,
  disabled,
  mentionables = [],
  commands = [],
  toolbar,
  onMentionsChange,
  onTextChange,
  streamingCount = 0,
  onStopStreaming,
  onSend,
}: Props) {
  const [text, setText] = useState(() => restoredText(channelId));
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<FileInfo[]>(
    () => (channelId && draftsByChannel.get(channelId)?.attachments) || []
  );
  const [uploading, setUploading] = useState(false);
  // Mentions the user has picked, keyed by id. Routing source of truth.
  const [picked, setPicked] = useState<MentionCandidate[]>(
    () => (channelId && draftsByChannel.get(channelId)?.picked) || []
  );
  const [picker, setPicker] = useState<PickerState | null>(null);
  // Paperclip → small menu (upload vs. pick existing) + the channel-file picker dialog.
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachRef = useRef<HTMLDivElement>(null);
  // Voice-to-deaf-bot guard state (used further below): audio attachments the
  // transcribe-then-send flow completed, and the paused-send warning.
  const [transcribedIds, setTranscribedIds] = useState<Set<string>>(
    () => (channelId && draftsByChannel.get(channelId)?.transcribedIds) || new Set()
  );
  const [voiceWarning, setVoiceWarning] = useState<{
    deafBots: string[];
    error?: string;
  } | null>(null);
  const [transcribing, setTranscribing] = useState(false);

  // Live snapshot of the stashable draft (read by the channel-switch effect and
  // the unmount stash below — refreshed every render, so always current).
  const draftRef = useRef<DraftState>({ text, attachments, picked, transcribedIds });
  draftRef.current = { text, attachments, picked, transcribedIds };
  const prevChannelRef = useRef(channelId);

  // Channel switch: stash the outgoing channel's draft, restore (or blank) the
  // incoming one, and drop all transient popup state — none of it survives a
  // room change (the parent separately resets the session target and mentions).
  useEffect(() => {
    const prev = prevChannelRef.current;
    if (prev === channelId) return;
    prevChannelRef.current = channelId;
    if (prev) stashDraft(prev, draftRef.current);
    const mem = channelId ? draftsByChannel.get(channelId) : undefined;
    setText(restoredText(channelId));
    setAttachments(mem?.attachments ?? []);
    setPicked(mem?.picked ?? []);
    setTranscribedIds(mem?.transcribedIds ?? new Set());
    setPicker(null);
    setAttachMenuOpen(false);
    setLibraryOpen(false);
    setVoiceWarning(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    });
  }, [channelId]);

  // Unmount (e.g. mobile back-navigation unmounts ChannelView): keep the draft.
  useEffect(
    () => () => {
      const prev = prevChannelRef.current;
      if (prev) stashDraft(prev, draftRef.current);
    },
    []
  );

  // Reload survival for the text (declared after the switch effect on purpose:
  // on a channel switch the restore reads sessionStorage before this rewrites it).
  useEffect(() => {
    if (!channelId) return;
    try {
      if (text) sessionStorage.setItem(draftKey(channelId), text);
      else sessionStorage.removeItem(draftKey(channelId));
    } catch {
      /* quota / private mode — the in-memory stash still covers switches */
    }
  }, [channelId, text]);

  // Bots whose "@label" token still survives in the draft — the live mention set
  // (mirrors submit()'s routing filter). Emitted up so the parent can show the
  // mentioned bot's session controls. Keyed by id so we only notify on change.
  const mentionedBots = useMemo(
    () => picked.filter((p) => p.type === "bot" && text.includes(`@${p.label}`)),
    [picked, text]
  );
  const mentionKey = mentionedBots.map((b) => b.id).join(",");
  useEffect(() => {
    onMentionsChange?.(mentionedBots);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionKey]);

  // Surface the draft text up for F3 suggested context (filename detection).
  useEffect(() => {
    onTextChange?.(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  async function handleFiles(files: FileList | null) {
    if (!files || !channelId) return;
    setUploading(true);
    try {
      // Per-file try/catch so one bad upload doesn't silently drop the rest of
      // the batch, and every failure surfaces a toast (the "uploading…" chip
      // just vanishing otherwise gives no signal the attachment was lost).
      for (const file of Array.from(files)) {
        try {
          const info = await uploadFile(channelId, file);
          setAttachments((prev) => [...prev, info]);
        } catch {
          toast.error(`Couldn't upload ${file.name} — try again`);
        }
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removeAttachment(fileId: string) {
    setAttachments((prev) => prev.filter((a) => a.file_id !== fileId));
  }

  // Attach files already uploaded to the channel — append, deduped by file_id (submit()
  // maps attachments → file_ids, so existing files flow through unchanged, no re-upload).
  function addExisting(files: FileInfo[]) {
    setAttachments((prev) => {
      const have = new Set(prev.map((a) => a.file_id));
      return [...prev, ...files.filter((f) => !have.has(f.file_id))];
    });
  }

  // Close the attach menu on outside click / Escape.
  const closeAttachMenu = useCallback(() => setAttachMenuOpen(false), []);
  usePopoverDismiss(attachMenuOpen, closeAttachMenu, attachRef);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  // Recompute the active picker token from the text up to the caret. The picker
  // opens on whichever trigger ("@" mention or "/" command) most recently starts
  // a word before the caret; it stays open only while the token has no whitespace.
  const refreshPicker = useCallback((value: string, caret: number) => {
    const upto = value.slice(0, caret);
    const atPos = upto.lastIndexOf("@");
    const slashPos = upto.lastIndexOf("/");
    // The later trigger wins (it's the one the caret is actually inside).
    const pos = Math.max(atPos, slashPos);
    if (pos === -1) return setPicker(null);
    const kind = pos === atPos ? "mention" : "command";
    const token = upto.slice(pos + 1);
    const startsWord = pos === 0 || /\s/.test(value[pos - 1]);
    if (!startsWord || /\s/.test(token)) return setPicker(null);
    setPicker({ kind, at: pos, query: token, index: 0 });
  }, []);

  // Group tokens (@all/@bots/…) join the real members in the picker so a human
  // can group-mention the room, just like a bot does via post_message.
  const mentionPool = useMemo(
    () => [...GROUP_MENTIONS, ...mentionables],
    [mentionables]
  );
  const filteredMentions =
    picker?.kind === "mention"
      ? mentionPool
          .filter((c) => {
            const q = picker.query.toLowerCase();
            return (
              c.label.toLowerCase().includes(q) ||
              (c.sublabel?.toLowerCase().includes(q) ?? false)
            );
          })
          // bots first (primary @target), then group tokens, then people.
          .sort((a, b) => mentionRank(a) - mentionRank(b))
          .slice(0, 8)
      : [];

  // Commands from more than one bot render grouped under bot headers; the sort
  // happens HERE (not in CommandPalette) so `picker.index` and the keyboard
  // navigation stay aligned with the render order.
  const multiBotCommands = useMemo(
    () => new Set(commands.map((c) => c.botId)).size > 1,
    [commands]
  );
  const filteredCommands =
    picker?.kind === "command"
      ? (() => {
          const q = picker.query.toLowerCase();
          const hits = commands.filter(
            (c) =>
              c.name.toLowerCase().includes(q) ||
              (c.description?.toLowerCase().includes(q) ?? false)
          );
          if (multiBotCommands)
            hits.sort(
              (a, b) =>
                a.botLabel.localeCompare(b.botLabel) || a.name.localeCompare(b.name)
            );
          return hits.slice(0, 8);
        })()
      : [];

  // The active list length drives keyboard navigation regardless of which picker
  // is open.
  const activeCount =
    picker?.kind === "command" ? filteredCommands.length : filteredMentions.length;

  function selectCandidate(c: MentionCandidate) {
    if (!picker) return;
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? text.length;
    const next =
      text.slice(0, picker.at) + `@${c.label} ` + text.slice(caret);
    setText(next);
    setPicked((prev) =>
      prev.some((p) => p.id === c.id) ? prev : [...prev, c]
    );
    setPicker(null);
    requestAnimationFrame(() => {
      const newPos = picker.at + c.label.length + 2; // "@label "
      el?.focus();
      el?.setSelectionRange(newPos, newPos);
      adjustHeight();
    });
  }

  // Insert "/name " at the active "/" trigger. Commands are not routed like
  // mentions — they live inline in the message text for the bot to interpret.
  function selectCommand(c: CommandCandidate) {
    if (!picker) return;
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? text.length;
    const next = text.slice(0, picker.at) + `/${c.name} ` + text.slice(caret);
    setText(next);
    setPicker(null);
    requestAnimationFrame(() => {
      const newPos = picker.at + c.name.length + 2; // "/name "
      el?.focus();
      el?.setSelectionRange(newPos, newPos);
      adjustHeight();
    });
  }

  // The "/" toolbar button: mouse/touch entry into the command picker. Inserts a
  // "/" trigger at the caret (padded to a word start — refreshPicker's rule) and
  // opens the same picker the keyboard path uses, keyboard navigation included.
  function openCommandPicker() {
    const el = textareaRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const insert = before && !/\s$/.test(before) ? " /" : "/";
    const next = before + insert + text.slice(caret);
    const newCaret = caret + insert.length;
    setText(next);
    setPicker({ kind: "command", at: newCaret - 1, query: "", index: 0 });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(newCaret, newCaret);
      adjustHeight();
    });
  }

  // Voice-to-deaf-bot guard: audio attachments not yet transcribed, headed at a
  // bot that can't hear audio, pause the send behind an explicit choice
  // (transcribe-then-send vs send-as-is). State lives in the top block above.
  function untranscribedAudio(): FileInfo[] {
    return attachments.filter(
      (a) => isAudioFile(a) && !a.summary && !transcribedIds.has(a.file_id)
    );
  }

  // Request transcription for every pending audio attachment, poll until all
  // transcripts land (2s interval, 120s ceiling), then send. Any failure keeps
  // the warning open with the error so "Send anyway" stays available.
  async function transcribeThenSend() {
    setTranscribing(true);
    try {
      const pending = untranscribedAudio();
      await Promise.all(pending.map((a) => transcribeFile(a.file_id)));
      const deadline = Date.now() + 120_000;
      const remaining = new Set(pending.map((a) => a.file_id));
      while (remaining.size && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        for (const id of Array.from(remaining)) {
          const s = await getFileStatus(id);
          if (s.transcript_status === "done") remaining.delete(id);
          else if (s.last_error) throw new Error(`Transcription failed: ${s.last_error}`);
        }
      }
      if (remaining.size) throw new Error("Transcription timed out — retry later or send anyway");
      setTranscribedIds((prev) => {
        const next = new Set(prev);
        pending.forEach((a) => next.add(a.file_id));
        return next;
      });
      setVoiceWarning(null);
      setTranscribing(false);
      await submit(true);
    } catch (e) {
      setTranscribing(false);
      setVoiceWarning((prev) =>
        prev
          ? { ...prev, error: e instanceof Error ? e.message : "Transcription failed" }
          : prev
      );
    }
  }

  async function submit(skipVoiceCheck = false) {
    const typed = text.trim();
    const fileIds = attachments.map((a) => a.file_id);
    // Backend requires non-empty content; fall back to attachment names.
    const content =
      typed ||
      (fileIds.length
        ? attachments.map((a) => a.original_filename || "file").join(", ")
        : "");
    if (!content || sending || uploading || disabled) return;
    // Pause the send when untranscribed voice is headed at a bot that can't
    // hear it (capability persisted from the connector handshake). Audio-capable
    // bots get native audio blocks, so no warning there.
    if (!skipVoiceCheck && untranscribedAudio().length > 0) {
      const deafBots = mentionedBots
        .filter((b) => b.canReceiveAudio !== true)
        .map((b) => b.label);
      if (deafBots.length > 0) {
        setVoiceWarning({ deafBots });
        return;
      }
    }
    setVoiceWarning(null);
    // Only keep mentions whose "@label" token still survives in the text, then
    // split them: real members → mention_ids, group tokens → mention_names (the
    // server expands @all/@bots/… into concrete members).
    const survivors = picked.filter((p) => typed.includes(`@${p.label}`));
    const ids = Array.from(
      new Set(survivors.filter((p) => p.type !== "group").map((p) => p.id))
    );
    const names = Array.from(
      new Set(survivors.filter((p) => p.type === "group").map((p) => p.id))
    );
    setSending(true);
    setText("");
    setPicked([]);
    setPicker(null);
    setAttachments([]);
    setTranscribedIds(new Set());
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    try {
      await onSend(content, ids, fileIds, names);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (picker && activeCount) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPicker({ ...picker, index: (picker.index + 1) % activeCount });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPicker({
          ...picker,
          index: (picker.index - 1 + activeCount) % activeCount,
        });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (picker.kind === "command") selectCommand(filteredCommands[picker.index]);
        else selectCandidate(filteredMentions[picker.index]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPicker(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  function handleInput(e: FormEvent<HTMLTextAreaElement>) {
    const value = e.currentTarget.value;
    setText(value);
    refreshPicker(value, e.currentTarget.selectionStart ?? value.length);
    adjustHeight();
  }

  const canSend =
    (text.trim().length > 0 || attachments.length > 0) &&
    !sending &&
    !uploading &&
    !disabled;

  // Send→stop morph: with an EMPTY draft while bot turns stream, the send slot
  // becomes Stop. A typed draft always keeps Send — interrupting is never the
  // price of talking. `stopping` guards double-fire; it re-arms when a new turn
  // starts streaming after all previous ones ended.
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (streamingCount === 0) setStopping(false);
  }, [streamingCount]);
  const showStop =
    !canSend && !disabled && !sending && streamingCount > 0 && !!onStopStreaming;
  const stopTitle =
    streamingCount > 1 ? "Stop all responses" : "Stop response";
  async function stopStreaming() {
    if (!onStopStreaming || stopping) return;
    setStopping(true);
    try {
      await onStopStreaming();
    } finally {
      // If some turns are still streaming (cancel refused / new turn), let the
      // button be pressed again; the effect above re-arms on full stop anyway.
      setStopping(false);
    }
  }

  return (
    // Mobile: tighter gutters + safe-area bottom padding so the input clears the
    // home indicator; the dvh root + interactive-widget=resizes-content keep it
    // above the on-screen keyboard.
    <div className="px-4 pb-4 pt-2 relative max-md:px-3 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {picker?.kind === "mention" && filteredMentions.length > 0 && (
        <div className="absolute bottom-full left-4 right-4 mb-2 max-h-60 overflow-y-auto rounded-lg bg-zinc-900 shadow-xl shadow-black/40 z-10">
          {filteredMentions.map((c, i) => (
            <button
              key={c.id}
              onMouseDown={(e) => {
                e.preventDefault();
                selectCandidate(c);
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                i === picker.index
                  ? "bg-indigo-600/30 text-zinc-100"
                  : "text-zinc-300 hover:bg-zinc-800"
              )}
            >
              {c.type === "bot" ? (
                <Bot className="w-4 h-4 text-indigo-400 flex-shrink-0" />
              ) : (
                <User className="w-4 h-4 text-zinc-400 flex-shrink-0" />
              )}
              <span className="font-medium">{c.label}</span>
              {c.sublabel && (
                <span className="text-xs text-zinc-400">@{c.sublabel}</span>
              )}
              {c.type === "bot" && (
                <span className="ml-auto text-[10px] px-1 py-0.5 rounded bg-indigo-900/60 text-indigo-300">
                  BOT
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {picker?.kind === "command" && filteredCommands.length > 0 && (
        <CommandPalette
          commands={filteredCommands}
          activeIndex={picker.index}
          onSelect={selectCommand}
          grouped={multiBotCommands}
        />
      )}

      {(attachments.length > 0 || uploading) && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <span
              key={a.file_id}
              className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-300"
            >
              <FileText className="w-3.5 h-3.5 text-indigo-400" />
              <span
                className="max-w-[160px] truncate"
                title={a.original_filename || a.file_id}
              >
                {a.original_filename || a.file_id.slice(0, 8)}
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(a.file_id)}
                className="text-zinc-400 hover:text-zinc-200"
                aria-label="Remove attachment"
                title="Remove attachment"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          {uploading && (
            <span className="inline-flex items-center text-xs text-zinc-400 px-1">
              uploading…
            </span>
          )}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />

      {libraryOpen && channelId && (
        <ExistingFilePicker
          channelId={channelId}
          attachedIds={attachments.map((a) => a.file_id)}
          onPick={addExisting}
          onClose={() => setLibraryOpen(false)}
        />
      )}

      {voiceWarning && (
        <div className="mb-2 rounded-lg bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
          <p className="flex items-center gap-1.5">
            <AudioLines className="h-3.5 w-3.5 flex-shrink-0" />
            {voiceWarning.deafBots.join(", ")} can't receive audio — without a transcript, it will only see the file name.
          </p>
          {voiceWarning.error && (
            <p className="mt-1 text-red-300">{voiceWarning.error}</p>
          )}
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void transcribeThenSend()}
              disabled={transcribing}
              className="inline-flex items-center gap-1 rounded bg-amber-600/80 px-2 py-1 text-amber-50 hover:bg-amber-600 disabled:opacity-50"
            >
              {transcribing && <Loader2 className="h-3 w-3 animate-spin" />}
              {transcribing ? "Transcribing…" : "Transcribe, then send"}
            </button>
            <button
              type="button"
              onClick={() => void submit(true)}
              disabled={transcribing}
              className="rounded bg-amber-900/40 px-2 py-1 text-amber-200 hover:bg-amber-900/60 disabled:opacity-50"
            >
              Send anyway
            </button>
            <button
              type="button"
              onClick={() => setVoiceWarning(null)}
              disabled={transcribing}
              className="ml-auto text-amber-400/70 hover:text-amber-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Unified composer card (DESIGN.md §2.3 borderless field): the textarea on
          top, a controls row (attach · session/model chips · commands · send)
          along the bottom. The ring is the focus state — no resting border. */}
      <div
        className={cn(
          "rounded-xl bg-zinc-800/80 transition-all",
          disabled
            ? "opacity-60"
            : "focus-within:bg-zinc-800 focus-within:ring-2 focus-within:ring-indigo-500/50"
        )}
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onClick={(e) =>
            refreshPicker(
              e.currentTarget.value,
              e.currentTarget.selectionStart ?? 0
            )
          }
          disabled={disabled || sending}
          placeholder={
            disabled
              ? "Select a channel to start chatting"
              : `Message ${channelName ? `#${channelName}` : "..."} — @ to mention a bot`
          }
          // text-base (16px) below md stops iOS Safari's auto-zoom on focus.
          className="block w-full bg-transparent text-base md:text-sm text-zinc-100 placeholder-zinc-400 resize-none outline-none leading-relaxed px-3 pt-2.5 pb-1 min-h-[24px] max-h-[200px]"
        />

        <div className="flex items-center gap-1 px-1.5 pb-1.5">
          <div ref={attachRef} className="relative flex-shrink-0">
            <button
              type="button"
              onClick={() => setAttachMenuOpen((o) => !o)}
              disabled={disabled || !channelId}
              className={cn(
                "w-8 h-8 max-md:w-10 max-md:h-10 rounded-lg flex items-center justify-center transition-colors disabled:opacity-40",
                attachMenuOpen
                  ? "text-zinc-200 bg-zinc-700/50"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50"
              )}
              aria-label="Attach file"
              title="Attach file"
            >
              <Paperclip className="w-4 h-4" />
            </button>
            {attachMenuOpen && (
              <PopoverPanel className="w-48 overflow-hidden rounded-lg py-1">
                <button
                  type="button"
                  onClick={() => {
                    setAttachMenuOpen(false);
                    fileInputRef.current?.click();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  <Upload className="w-3.5 h-3.5 text-zinc-500" />
                  Upload from computer
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAttachMenuOpen(false);
                    setLibraryOpen(true);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  <FolderOpen className="w-3.5 h-3.5 text-zinc-500" />
                  Pick a channel file
                </button>
              </PopoverPanel>
            )}
          </div>

          {/* Session + model chips from the parent; min-w-0 lets them truncate
              instead of pushing the send button off a narrow screen. */}
          {toolbar && (
            <div className="flex min-w-0 items-center gap-1">{toolbar}</div>
          )}

          {commands.length > 0 && (
            <button
              type="button"
              onClick={openCommandPicker}
              disabled={disabled || sending}
              className="w-8 h-8 max-md:w-10 max-md:h-10 rounded-lg flex items-center justify-center transition-colors disabled:opacity-40 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 flex-shrink-0"
              aria-label="Insert a command"
              title="Commands (/)"
            >
              <SquareSlash className="w-4 h-4" />
            </button>
          )}

          <div className="flex-1" />

          {showStop ? (
            <button
              onClick={() => void stopStreaming()}
              disabled={stopping}
              className="flex-shrink-0 w-8 h-8 max-md:w-10 max-md:h-10 rounded-lg flex items-center justify-center transition-all duration-150 bg-zinc-700/50 text-red-400 hover:bg-red-950/40 hover:text-red-300 disabled:opacity-50"
              aria-label={stopTitle}
              title={stopTitle}
            >
              <Square className="w-3.5 h-3.5" fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={() => void submit()}
              disabled={!canSend}
              className={cn(
                "flex-shrink-0 w-8 h-8 max-md:w-10 max-md:h-10 rounded-lg flex items-center justify-center transition-all duration-150",
                canSend
                  ? "bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer shadow-sm"
                  : "bg-zinc-700/50 text-zinc-600 cursor-not-allowed"
              )}
              aria-label="Send message"
              title="Send message"
            >
              <SendHorizontal className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
      {/* Hardware-keyboard hints — meaningless on touch, so hidden below md. */}
      <p className="text-[11px] text-zinc-400 mt-1.5 px-1 max-md:hidden">
        <kbd className="font-mono">Enter</kbd> to send ·{" "}
        <kbd className="font-mono">Shift+Enter</kbd> for new line ·{" "}
        <kbd className="font-mono">@</kbd> to mention ·{" "}
        <kbd className="font-mono">/</kbd> for commands
      </p>
    </div>
  );
}

// Memoized: the composer holds live draft/typing state, so keeping it out of
// ChannelView's per-delta streaming re-renders preserves typing latency. All props
// are now stable (memoized toolbar, useCallback onSend/onMentionsChange).
export const MessageComposer = memo(MessageComposerImpl);

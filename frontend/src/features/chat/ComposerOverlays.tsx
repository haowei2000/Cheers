import { AudioLines, Bot, FileText, Loader2, SendHorizontal, User, X } from "lucide-react";
import type { FileInfo } from "@/types";
import { Button } from "@/components/ui/button";
import { Banner } from "@/components/ui/banner";
import { IconButton } from "@/components/ui/icon-button";
import { ItemChip, NavigationItem } from "@/components/ui/item";
import { OverflowText } from "@/components/ui/overflow-text";
import { cn } from "@/lib/cn";
import type { MentionCandidate } from "./MessageComposer";

export function ComposerMentionPicker({
  candidates,
  activeIndex,
  onSelect,
}: {
  candidates: MentionCandidate[];
  activeIndex: number;
  onSelect: (candidate: MentionCandidate) => void;
}) {
  return (
    <div className="absolute bottom-full left-4 right-4 z-10 mb-2 max-h-60 overflow-y-auto rounded-sm bg-zinc-900 shadow-xl shadow-black/40">
      {candidates.map((candidate, index) => (
        <NavigationItem
          key={candidate.id}
          onClick={(event) => event.detail === 0 && onSelect(candidate)}
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(candidate);
          }}
          title={candidate.label}
          status={candidate.sublabel ? <span className="truncate text-compact text-content-muted">@{candidate.sublabel}</span> : undefined}
          leading={candidate.type === "bot" ? (
            <Bot className={cn("w-4 h-4 flex-shrink-0", candidate.isOnline === false ? "text-content-muted" : "text-accent-400")} />
          ) : (
            <User className="w-4 h-4 text-content-muted flex-shrink-0" />
          )}
          criticalStatus={candidate.type === "bot" ? <span className="text-minimal text-accent-300">{candidate.isOnline === false ? "OFFLINE" : "BOT"}</span> : undefined}
          selected={index === activeIndex}
          className={cn(
            index === activeIndex
              ? "bg-indigo-600/30 text-content-primary"
              : candidate.type === "bot" && candidate.isOnline === false
                ? "text-content-muted hover:bg-zinc-800"
                : "text-content-secondary hover:bg-zinc-800",
          )}
        />
      ))}
    </div>
  );
}

export function ComposerAttachments({
  attachments,
  uploading,
  onRemove,
}: {
  attachments: FileInfo[];
  uploading: boolean;
  onRemove: (fileId: string) => void;
}) {
  if (!attachments.length && !uploading) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <ItemChip
          key={attachment.file_id}
          label={
            <OverflowText fullText={attachment.original_filename || attachment.file_id} touchDisclosure={false}>
              {attachment.original_filename || attachment.file_id.slice(0, 8)}
            </OverflowText>
          }
          leading={<FileText className="w-3.5 h-3.5 text-accent-400" />}
          controlSize="regular"
          className="bg-zinc-800 text-content-secondary"
          actions={
            <IconButton
              onClick={() => onRemove(attachment.file_id)}
              label={`Remove attachment ${attachment.original_filename || attachment.file_id}`}
              title="Remove attachment"
              controlSize="compact"
            >
              <X className="w-3.5 h-3.5" />
            </IconButton>
          }
        />
      ))}
      {uploading && <span className="inline-flex items-center px-1 text-compact text-content-muted">uploading…</span>}
    </div>
  );
}

export function ComposerVoiceWarning({
  botNames,
  error,
  transcribing,
  onTranscribe,
  onSendWithoutTranscript,
  onCancel,
}: {
  botNames: string[];
  error?: string;
  transcribing: boolean;
  onTranscribe: () => void;
  onSendWithoutTranscript: () => void;
  onCancel: () => void;
}) {
  return (
    <Banner severity="warning" icon={AudioLines} className="mb-2">
      <p>
        {botNames.join(", ")} can&apos;t receive audio — without a transcript, it will only see the file name.
      </p>
      {error && <p className="mt-1 text-danger-300">{error}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          type="button"
          onClick={onTranscribe}
          disabled={transcribing}
          controlSize="regular"
          content="iconText"
          action="transcribe"
          aria-label="Transcribe the audio attachment, then send the message"
        >
          {transcribing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AudioLines className="h-3.5 w-3.5" />}
        </Button>
        <Button
          variant="secondary"
          type="button"
          onClick={onSendWithoutTranscript}
          disabled={transcribing}
          controlSize="regular"
          content="iconText"
          action="send"
          aria-label="Send the audio attachment without a transcript"
        >
          <SendHorizontal className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="plain"
          type="button"
          onClick={onCancel}
          disabled={transcribing}
          controlSize="regular"
          action="cancel"
          aria-label="Cancel audio attachment warning"
          className="ml-auto text-warning-400/70 hover:text-warning-200"
        />
      </div>
    </Banner>
  );
}

import { ActionButton } from "@/components/ui/action-button";
import { Button as UiButton } from "@/components/ui/button";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { IconButton } from "@/components/ui/icon-button";
import { PopoverPanel, usePopoverDismiss } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { EditorialIcon } from "@/components/ui/editorial-icons";
import { Crosshair, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type { Annotation, NewAnnotation } from "./annotations";
import { resolveAnnotation } from "./annotations";

export function formatNoteDate(iso?: string): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    const isSameYear = d.getFullYear() === now.getFullYear();
    const month = d.getMonth() + 1;
    const day = d.getDate();
    return isSameYear ? `${month}/${day}` : `${d.getFullYear()}/${month}/${day}`;
  } catch {
    return null;
  }
}

export interface AnnotationsButtonProps {
  notes: readonly Annotation[];
  allNotes?: readonly Annotation[];
  currentPath?: string;
  defaultOpen?: boolean;
  /** The file's current text, for resolving each anchor to where it now points. */
  text?: string;
  activeAnnotationId?: string | null;
  onSelectAnnotation?: (id: string | null) => void;
  onRemove: (id: string) => void;
  onReveal?: (range: { start: number; end: number }) => void;
  onSelectFile?: (path: string) => void;
  onAddNote?: (entry: NewAnnotation) => Promise<void> | void;
}

export interface AnnotationListContentProps {
  notes: readonly Annotation[];
  allNotes?: readonly Annotation[];
  currentPath?: string;
  text?: string;
  activeAnnotationId?: string | null;
  onSelectAnnotation?: (id: string | null) => void;
  onRemove: (id: string) => void;
  onReveal?: (range: { start: number; end: number }) => void;
  onSelectFile?: (path: string) => void;
  onAddNote?: (entry: NewAnnotation) => Promise<void> | void;
  onClose?: () => void;
}

export function AnnotationListContent({
  notes,
  allNotes,
  currentPath,
  text = "",
  activeAnnotationId,
  onSelectAnnotation,
  onRemove,
  onReveal,
  onSelectFile,
  onAddNote,
  onClose,
}: AnnotationListContentProps) {
  const [scope, setScope] = useState<"file" | "all">("file");
  const [isComposing, setIsComposing] = useState(false);
  const [newNoteText, setNewNoteText] = useState("");

  const allList = allNotes ?? notes;
  const displayedNotes = scope === "file" ? notes : allList;
  const showScopeTabs = Boolean(allNotes && allNotes.length > 0 && currentPath);

  const handleReveal = (note: Annotation, range: { start: number; end: number } | null) => {
    onSelectAnnotation?.(note.id);
    if (note.path !== currentPath && onSelectFile) {
      onSelectFile(note.path);
    }
    if (range && onReveal) {
      onReveal(range);
    }
    onClose?.();
  };

  const submitNewNote = async () => {
    if (!newNoteText.trim() || !currentPath || !onAddNote) return;
    const fileName = currentPath.split("/").pop() || currentPath;
    await onAddNote({
      path: currentPath,
      anchor: { kind: "file" },
      label: fileName,
      note: newNoteText.trim(),
    });
    setNewNoteText("");
    setIsComposing(false);
  };

  return (
    <div className="w-96 max-w-full text-content-primary">
      {/* One band of chrome. The panel was captioned "Annotations" and given a count,
          directly under the control you opened it from and directly above the list it
          counts — both said what the screen already showed. What is left is the mark,
          the one scope that is not currently shown, and the single + every other
          toolbar in the app uses to make one of these. */}
      <div className="flex items-center gap-2 border-b border-control/50 bg-control/10 px-3 py-2">
        <EditorialIcon name="annotation" contentSize="regular" className="flex-shrink-0 text-content-muted" />
        {showScopeTabs && (
          // A scope name is not an action, so this is the selector primitive rather
          // than a Button with a fabricated action key. Its registered slot width also
          // keeps the control still while the label inside it changes.
          <ControlTrigger
            controlSize="compact"
            selected={scope === "all"}
            onClick={() => setScope(scope === "file" ? "all" : "file")}
            // Two tabs for two states spent a row naming the one you were already
            // looking at. One control carries the state it is in, and its accessible
            // name says what pressing it does — which a tab's "selected" never did.
            aria-label={
              scope === "file"
                ? `Showing this file's annotations. Show all files (${allList.length}).`
                : `Showing all files' annotations. Show this file only (${notes.length}).`
            }
          >
            <span className="truncate">
              {scope === "file" ? `This file (${notes.length})` : `All files (${allList.length})`}
            </span>
          </ControlTrigger>
        )}
        <div className="flex-1" />
        {onAddNote && currentPath && !isComposing && (
          <ActionButton
            action="add"
            context="toolbar"
            accessibleLabel="Add note"
            controlSize="compact"
            onClick={() => setIsComposing(true)}
          />
        )}
        {onClose && (
          <ActionButton
            action="close"
            context="windowChrome"
            accessibleLabel="Close annotations"
            controlSize="compact"
            onClick={onClose}
          />
        )}
      </div>

      {isComposing && (
        <div className="flex flex-col gap-2 border-b border-control/40 bg-control/15 p-3">
          <div className="flex items-center justify-between">
            <span className="text-minimal font-medium text-content-secondary">
              Add note on <span className="font-code text-content-primary">{currentPath ? currentPath.split("/").pop() : "document"}</span>
            </span>
          </div>
          <Textarea
            value={newNoteText}
            onChange={(event) => setNewNoteText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setIsComposing(false);
                setNewNoteText("");
              } else if (
                (event.key === "Enter" && !event.shiftKey) ||
                (event.key === "Enter" && (event.metaKey || event.ctrlKey))
              ) {
                event.preventDefault();
                void submitNewNote();
              }
            }}
            placeholder="What should be said about this?"
            controlSize="regular"
            rows={3}
            aria-label="New note content"
            autoFocus
          />
          <div className="flex items-center justify-end gap-2">
            <UiButton
              action="cancel"
              variant="plain"
              controlSize="compact"
              onClick={() => {
                setIsComposing(false);
                setNewNoteText("");
              }}
              className="text-content-primary hover:text-content-strong"
            >
              Cancel
            </UiButton>
            <ActionButton
              action="save"
              context="form"
              accessibleLabel="Save note"
              controlSize="compact"
              disabled={!newNoteText.trim()}
              onClick={() => void submitNewNote()}
            />
          </div>
        </div>
      )}

      {displayedNotes.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-6 text-center">
          <EditorialIcon name="annotation" contentSize="large" className="mb-2 text-content-muted/50" />
          <p className="text-compact font-medium text-content-primary">
            {scope === "file" ? "No annotations on this file" : "No annotations in workspace"}
          </p>
          <p className="mt-1 text-minimal text-content-muted">
            Notes keep bookmarks, remarks, or reminders on files.
          </p>
          {onAddNote && currentPath && !isComposing && (
            <div className="mt-3">
              <UiButton
                action="add"
                variant="secondary"
                controlSize="compact"
                content="text"
                controlWidth="content"
                onClick={() => setIsComposing(true)}
              >
                Add note
              </UiButton>
            </div>
          )}
        </div>
      ) : (
        <ul role="list" aria-label="Annotations list" className="flex max-h-72 flex-col divide-y divide-control/20 overflow-y-auto">
          {displayedNotes.map((note) => {
            const isCurrentFile = note.path === currentPath;
            const range = isCurrentFile && text ? resolveAnnotation(note, text) : null;
            const showFilePath = scope === "all" || !isCurrentFile;
            const formattedDate = formatNoteDate(note.created);
            const isSelected = note.id === activeAnnotationId;
            return (
              <li
                key={note.id}
                tabIndex={0}
                role="listitem"
                aria-current={isSelected ? "true" : undefined}
                onClick={() => onSelectAnnotation?.(note.id)}
                onKeyDown={(event) => {
                  if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    handleReveal(note, range);
                  }
                }}
                className={`group flex flex-col gap-1 p-3 transition-colors cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-accent-500 focus-visible:ring-inset ${
                  isSelected ? "bg-control/30 ring-1 ring-accent-400/40" : "hover:bg-control/20"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1 overflow-hidden">
                    {showFilePath && (
                      <span
                        className="max-w-[120px] truncate rounded-sm bg-control/60 px-1 font-code text-minimal text-content-muted"
                        title={note.path}
                      >
                        {note.path.split("/").pop()}
                      </span>
                    )}
                    <span className="truncate font-medium text-compact text-content-primary" title={note.label}>
                      {note.label}
                    </span>
                    {range ? (
                      <span
                        className="flex-shrink-0 font-code text-minimal text-content-muted"
                        title={`Lines ${range.start}–${range.end}`}
                      >
                        L{range.start}{range.end !== range.start ? `–${range.end}` : ""}
                      </span>
                    ) : isCurrentFile && note.anchor.kind !== "file" ? (
                      <span
                        className="flex-shrink-0 text-minimal font-medium text-warning-500 dark:text-warning-400"
                        title="Anchor was moved or deleted in this file"
                      >
                        stale
                      </span>
                    ) : (
                      <span className="flex-shrink-0 text-minimal text-content-muted">
                        file
                      </span>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1">
                    {formattedDate && (
                      <span className="text-minimal text-content-muted">
                        {formattedDate}
                      </span>
                    )}
                    <IconButton
                      label={
                        range
                          ? `Show lines ${range.start}–${range.end}`
                          : isCurrentFile
                            ? `Focus ${note.label}`
                            : `Open ${note.path.split("/").pop() || note.path}`
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        handleReveal(note, range);
                      }}
                      controlSize="compact"
                    >
                      <Crosshair className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton
                      label={`Remove note on ${note.label}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(note.id);
                      }}
                      controlSize="compact"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                </div>
                {/* One line each. A note is a remark, not a document: let one wrap and
                    a handful of them push the rest off a list you opened to scan. The
                    whole text stays one hover (or one click through to the anchor) away. */}
                <p
                  className="select-text truncate pl-1 text-compact text-content-secondary"
                  title={note.note}
                >
                  {note.note}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The file's notes, behind one button in the panel's action corner. */
export function AnnotationsButton({
  notes,
  allNotes,
  currentPath,
  defaultOpen = false,
  text = "",
  activeAnnotationId,
  onSelectAnnotation,
  onRemove,
  onReveal,
  onSelectFile,
  onAddNote,
}: AnnotationsButtonProps) {
  const [open, setOpen] = useState(defaultOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, () => setOpen(false), rootRef);

  const totalCount = notes.length;
  const workspaceCount = allNotes?.length ?? totalCount;

  return (
    <div ref={rootRef} className="relative inline-flex">
      <IconButton
        label={
          totalCount === 0
            ? workspaceCount > 0
              ? `Annotations (${workspaceCount} in workspace)`
              : "Annotations"
            : `${totalCount} annotation${totalCount > 1 ? "s" : ""}`
        }
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => {
            const next = !current;
            if (next && notes.length > 0 && !activeAnnotationId) {
              onSelectAnnotation?.(notes[0].id);
            }
            return next;
          });
        }}
        controlSize="compact"
      >
        <span className="relative inline-flex">
          <EditorialIcon name="annotation" contentSize="small" />
          {totalCount > 0 ? (
            <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-sm bg-accent-400" aria-hidden="true" />
          ) : workspaceCount > 0 ? (
            <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-sm bg-content-muted" aria-hidden="true" />
          ) : null}
        </span>
      </IconButton>
      {open && (
        <PopoverPanel placement="down" align="end" className="w-96 max-w-[calc(100vw-2rem)] overflow-hidden p-0">
          <AnnotationListContent
            notes={notes}
            allNotes={allNotes}
            currentPath={currentPath}
            text={text}
            activeAnnotationId={activeAnnotationId}
            onSelectAnnotation={onSelectAnnotation}
            onRemove={onRemove}
            onReveal={onReveal}
            onSelectFile={onSelectFile}
            onAddNote={onAddNote}
            onClose={() => setOpen(false)}
          />
        </PopoverPanel>
      )}
    </div>
  );
}

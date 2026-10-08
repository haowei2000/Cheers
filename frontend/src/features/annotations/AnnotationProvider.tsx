import { createPortal } from "react-dom";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { AnnotationTarget, SavedAnnotation } from "@/api/annotations";
import { ActionButton } from "@/components/ui/action-button";
import { Button } from "@/components/ui/button";
import { CollectionManager } from "@/components/ui/collection-manager";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { EditorialIcon } from "@/components/ui/editorial-icons";
import { IconButton } from "@/components/ui/icon-button";
import { ItemGroup, WorkbenchItem } from "@/components/ui/item";
import { Textarea } from "@/components/ui/textarea";
import { Banner } from "@/components/ui/banner";
import { sameTarget, annotationFeedback, eventTarget } from "./model";
import { useChannelAnnotations } from "./useAnnotations";
import type { TraceEvent } from "@/types";

interface Selection {
  target?: AnnotationTarget;
  label?: string;
  reveal?: (item: SavedAnnotation) => void;
}
interface AnnotationContext {
  notes: SavedAnnotation[];
  activeTarget?: AnnotationTarget;
  revealed: SavedAnnotation | null;
  open: (selection?: Selection) => void;
}
const Context = createContext<AnnotationContext | null>(null);
export const useAnnotationSurface = () => useContext(Context);

export function AnnotationProvider({
  channelId,
  userId,
  canManage,
  canWrite = true,
  onReveal,
  onCompose,
  children,
}: {
  channelId: string;
  userId?: string;
  canManage?: boolean;
  canWrite?: boolean;
  onReveal: (item: SavedAnnotation) => void | Promise<void>;
  onCompose: (text: string, item: SavedAnnotation) => void;
  children: ReactNode;
}) {
  const store = useChannelAnnotations(channelId);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"target" | "all" | "file" | "event">(
    "all",
  );
  const [mode, setMode] = useState<"browse" | "add" | "edit" | "delete">(
    "browse",
  );
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState<"close" | "cancel" | null>(null);
  const [revealed, setRevealed] = useState<SavedAnnotation | null>(null);
  const open = (next: Selection = {}) => {
    if (selection && (mode === "add" || mode === "edit") && draft.trim()) {
      setError(
        "Save or cancel the current note before selecting another object.",
      );
      return;
    }
    setSelection(next);
    setScope(next.target ? "target" : "all");
    setQuery("");
    setMode("browse");
    setDraft("");
    setError(null);
    setActive(null);
  };
  const close = () => {
    if (store.pending) return;
    if ((mode === "add" || mode === "edit") && draft.trim()) {
      setDiscard("close");
      return;
    }
    setSelection(null);
  };
  const handle = async (operation: () => Promise<unknown>) => {
    setError(null);
    try {
      await operation();
      setMode("browse");
      setDraft("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not save annotation. Retry.",
      );
    }
  };
  const selected = store.notes.find((n) => n.id === active);
  const editable = (item: SavedAnnotation) =>
    canWrite && (item.author_id === userId || Boolean(canManage));
  const visible = store.notes.filter(
    (n) =>
      (scope === "all" ||
        (scope === "target" &&
          selection?.target &&
          sameTarget(n.target, selection.target)) ||
        n.target.kind === scope) &&
      `${n.label} ${n.note} ${n.target.kind === "file" ? n.target.path : n.target.msg_id}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const editor = (item?: SavedAnnotation) => (
    <div className="space-y-2 p-3">
      <label
        className="block text-regular text-content-secondary"
        htmlFor="annotation-note"
      >
        {item
          ? `Edit: ${item.label}`
          : `Note on ${selection?.label ?? "selected object"}`}
      </label>
      <Textarea
        id="annotation-note"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={4}
        autoFocus
        disabled={store.pending}
        maxLength={16384}
        aria-label="Annotation note"
        controlSize="regular"
        onKeyDown={(e) => {
          if (
            e.key === "Enter" &&
            (e.metaKey || e.ctrlKey) &&
            !e.nativeEvent.isComposing
          ) {
            e.preventDefault();
            submit(item);
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <ActionButton
          action="cancel"
          context="inlineEdit"
          accessibleLabel="Cancel annotation edit"
          disabled={store.pending}
          onClick={() => {
            if (draft.trim()) setDiscard("cancel");
            else setMode("browse");
          }}
        />
        <ActionButton
          action="save"
          context="inlineEdit"
          accessibleLabel="Save annotation"
          disabled={store.pending || !draft.trim()}
          onClick={() => submit(item)}
        />
      </div>
    </div>
  );
  const submit = (item?: SavedAnnotation) => {
    if (!draft.trim() || store.pending) return;
    if (item) void handle(() => store.edit({ item, note: draft }));
    else if (selection?.target)
      void handle(() =>
        store.add({
          target: selection.target!,
          label: selection.label ?? "Annotation",
          note: draft,
        }),
      );
  };
  return (
    <Context.Provider
      value={{
        notes: store.notes,
        activeTarget: selection?.target,
        revealed,
        open,
      }}
    >
      {children}
      {selection &&
        createPortal(
          <FloatingPanel
            title="Annotations"
            onClose={close}
            storageKey={`cheers.annotations.${channelId}`}
            viewport
            className="h-[min(40rem,calc(100dvh-10rem))] w-96 max-w-[calc(100vw-2rem)]"
            panelActions={[
              {
                id: "refresh-annotations",
                label: "Refresh annotations",
                priority: "secondary",
                onSelect: () => void store.refetch(),
              },
            ]}
            bodyClassName="p-3"
            defaultPosClassName="top-20 right-4"
          >
            <div
              aria-busy={store.pending || store.isLoading}
              className="space-y-3"
            >
              {discard ? (
                <Banner severity="warning">
                  <p>Discard the unsaved note?</p>
                  <div className="flex gap-2 mt-2">
                    <Button action="cancel" onClick={() => setDiscard(null)}>
                      Cancel
                    </Button>
                    <Button
                      action="discard"
                      onClick={() => {
                        setDraft("");
                        setMode("browse");
                        if (discard === "close") setSelection(null);
                        setDiscard(null);
                      }}
                    >
                      Discard
                    </Button>
                  </div>
                </Banner>
              ) : null}
              {store.importWarning && (
                <Banner severity="warning">{store.importWarning}</Banner>
              )}
              {(error || store.error) && (
                <Banner severity="error">
                  {error ?? store.error?.message}
                  <ActionButton
                    action="refresh"
                    context="windowChrome"
                    accessibleLabel="Reload annotations"
                    onClick={() => void store.refetch()}
                  />
                </Banner>
              )}
              <CollectionManager
                label="Annotations"
                count={visible.length}
                query={query}
                onQueryChange={setQuery}
                addLabel="Add annotation on selected object"
                showAdd={canWrite && Boolean(selection.target)}
                onAdd={() => {
                  setDraft("");
                  setMode("add");
                  setActive(null);
                }}
                addDisabled={mode !== "browse" || store.pending}
                tabs={
                  <div
                    className="flex flex-wrap gap-2"
                    role="group"
                    aria-label="Annotation scope"
                  >
                    {(
                      [
                        ...(selection.target ? ["target"] : []),
                        "all",
                        "file",
                        "event",
                      ] as const
                    ).map((value) => (
                      <ControlTrigger
                        key={value}
                        controlSize="regular"
                        selected={scope === value}
                        aria-pressed={scope === value}
                        onClick={() => setScope(value as typeof scope)}
                      >
                        {value === "target"
                          ? "This object"
                          : value === "all"
                            ? "Channel"
                            : value === "file"
                              ? "Files"
                              : "Events"}
                      </ControlTrigger>
                    ))}
                  </div>
                }
              >
                {mode === "add" && <ItemGroup>{editor()}</ItemGroup>}
                {store.isLoading && (
                  <WorkbenchItem title="Loading annotations…" />
                )}
                {!store.isLoading && visible.length === 0 && (
                  <WorkbenchItem
                    title={
                      query
                        ? "No matching annotations"
                        : "No annotations in this scope"
                    }
                  />
                )}
                {visible.map((item) => (
                  <ItemGroup key={item.id}>
                    <WorkbenchItem
                      leading={<EditorialIcon name="annotation" />}
                      title={item.label}
                      selected={active === item.id}
                      status={item.target.kind === "file" ? "File" : "Event"}
                      onClick={() => {
                        if (mode !== "browse") return;
                        setActive(active === item.id ? null : item.id);
                      }}
                    />
                    {active === item.id &&
                      (mode === "edit" ? (
                        editor(item)
                      ) : mode === "delete" ? (
                        <div className="p-3 space-y-2">
                          <p className="text-regular">
                            Delete this annotation?
                          </p>
                          <div className="flex gap-2">
                            <ActionButton
                              action="cancel"
                              context="confirmation"
                              disabled={store.pending}
                              onClick={() => setMode("browse")}
                            />
                            <ActionButton
                              action="delete"
                              context="confirmation"
                              disabled={store.pending}
                              onClick={() =>
                                void handle(() => store.remove(item))
                              }
                            />
                          </div>
                        </div>
                      ) : (
                        <div className="p-3 space-y-3">
                          <p className="whitespace-pre-wrap wrap-break-word font-reading text-regular text-content-primary">
                            {item.note}
                          </p>
                          <p className="text-compact text-content-muted">
                            {item.author_id === userId
                              ? "You"
                              : item.author_id
                                ? "Channel member"
                                : "Author unavailable"}{" "}
                            · {new Date(item.created_at).toLocaleDateString()}
                          </p>
                          <p className="font-code text-compact break-all text-content-muted">
                            {item.target.kind === "file"
                              ? item.target.path
                              : `${item.target.snapshot.phase} · ${item.target.event_id.slice(0, 8)}`}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            <ActionButton
                              action="open"
                              context="settings"
                              accessibleLabel="Locate annotation source"
                              onClick={() => {
                                setRevealed({ ...item });
                                setSelection(null);
                                void (
                                  item.target.kind === "file" &&
                                    selection.reveal
                                    ? selection.reveal
                                    : onReveal
                                )(item);
                              }}
                            />
                            <Button
                              action="send"
                              aria-label="Add annotation and source to message draft"
                              title="Add to message draft"
                              onClick={() => {
                                onCompose(annotationFeedback(item), item);
                                setSelection(null);
                              }}
                            >
                              Send
                            </Button>
                            {editable(item) && (
                              <>
                                <ActionButton
                                  action="edit"
                                  context="inlineEdit"
                                  accessibleLabel="Edit annotation"
                                  onClick={() => {
                                    setDraft(item.note);
                                    setMode("edit");
                                  }}
                                />
                                <ActionButton
                                  action="delete"
                                  context="inlineEdit"
                                  accessibleLabel="Delete annotation"
                                  onClick={() => setMode("delete")}
                                />
                              </>
                            )}
                          </div>
                          <p className="text-compact text-content-muted">
                            Send adds the note and its source to your message
                            draft for review.
                          </p>
                        </div>
                      ))}
                  </ItemGroup>
                ))}
              </CollectionManager>
              {mode === "browse" && selected && (
                <span className="sr-only" role="status">
                  Selected annotation: {selected.label}
                </span>
              )}
            </div>
          </FloatingPanel>,
          document.body,
        )}
    </Context.Provider>
  );
}

export function AnnotationsLauncher() {
  const surface = useAnnotationSurface();
  return surface ? (
    <IconButton
      label={`Annotations (${surface.notes.length})`}
      controlSize="comfortable"
      onClick={() => surface.open()}
    >
      <EditorialIcon name="annotation" />
    </IconButton>
  ) : null;
}
export function EventAnnotationButton({ event }: { event: TraceEvent }) {
  const surface = useAnnotationSurface();
  if (!surface) return null;
  const target = eventTarget(event);
  const count = surface.notes.filter((n) =>
    sameTarget(n.target, target),
  ).length;
  return (
    <IconButton
      label={`Annotations on ${event.title ?? event.phase} (${count})`}
      controlSize="comfortable"
      onClick={() =>
        surface.open({ target, label: event.title ?? event.phase })
      }
    >
      <EditorialIcon name="annotation" />
      {count > 0 && <span className="text-compact">{count}</span>}
    </IconButton>
  );
}

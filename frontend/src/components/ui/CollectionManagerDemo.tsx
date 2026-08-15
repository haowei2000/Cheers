import { useMemo, useState } from "react";
import { Link2, Pencil, Radio, Trash2 } from "lucide-react";
import {
  CollectionDeleteItem,
  CollectionEditorItem,
  CollectionEmptyItem,
  CollectionManager,
  type CollectionMode,
} from "./collection-manager";
import { controlIconClasses } from "./control-size";
import { Field } from "./field";
import { IconButton } from "./icon-button";
import { Input } from "./input";
import { OperationsItem } from "./item";

interface DemoRecord {
  id: string;
  title: string;
  scope: string;
  metadata: string;
  type: "claim" | "link";
}

const initialRecords: DemoRecord[] = [
  {
    id: "claim-opencode",
    title: "OpenCode task claiming",
    scope: "Frontend implementation · Text messages",
    metadata: "15s debounce · Human approval required",
    type: "claim",
  },
  {
    id: "link-seven-day",
    title: "7-day invite link",
    scope: "#claim_test · Unlimited uses",
    metadata: "Created today · Active",
    type: "link",
  },
];

/** Interactive reference fixture; production screens consume the same primitives. */
export function CollectionManagerDemo() {
  const [records, setRecords] = useState(initialRecords);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<CollectionMode>({ kind: "browse" });
  const [draftTitle, setDraftTitle] = useState("");
  const [draftScope, setDraftScope] = useState("");

  const visibleRecords = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return records;
    return records.filter((record) =>
      `${record.title} ${record.scope} ${record.metadata}`.toLocaleLowerCase().includes(normalized),
    );
  }, [query, records]);

  const beginAdd = () => {
    setDraftTitle("");
    setDraftScope("");
    setMode({ kind: "add" });
  };
  const beginEdit = (record: DemoRecord) => {
    setDraftTitle(record.title);
    setDraftScope(record.scope);
    setMode({ kind: "edit", id: record.id });
  };
  const cancel = () => setMode({ kind: "browse" });
  const save = () => {
    const title = draftTitle.trim();
    const scope = draftScope.trim();
    if (!title || !scope) return;
    if (mode.kind === "add") {
      setRecords((current) => [
        {
          id: `demo-${Date.now()}`,
          title,
          scope,
          metadata: "New item · Draft settings",
          type: "claim",
        },
        ...current,
      ]);
    } else if (mode.kind === "edit") {
      setRecords((current) => current.map((record) => (
        record.id === mode.id ? { ...record, title, scope } : record
      )));
    }
    setMode({ kind: "browse" });
  };

  const editor = (kind: "add" | "edit") => (
    <CollectionEditorItem
      mode={kind}
      title={kind === "add" ? "Add managed item" : "Edit managed item"}
      onCancel={cancel}
      onSave={save}
      saveDisabled={!draftTitle.trim() || !draftScope.trim()}
    >
      <Field label="Name" htmlFor={`collection-${kind}-name`}>
        <Input
          id={`collection-${kind}-name`}
          controlSize="regular"
          value={draftTitle}
          onChange={(event) => setDraftTitle(event.target.value)}
          placeholder="Example: OpenCode task claiming"
        />
      </Field>
      <Field label="Scope" htmlFor={`collection-${kind}-scope`}>
        <Input
          id={`collection-${kind}-scope`}
          controlSize="regular"
          value={draftScope}
          onChange={(event) => setDraftScope(event.target.value)}
          placeholder="Channel, expiry, policy, or responsibility"
        />
      </Field>
    </CollectionEditorItem>
  );

  return (
    <CollectionManager
      label="Managed collection"
      count={records.length}
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="Search claims and links"
      addLabel="Add item"
      onAdd={beginAdd}
      addDisabled={mode.kind !== "browse"}
    >
      {mode.kind === "add" && editor("add")}

      {visibleRecords.map((record) => {
        if (mode.kind === "edit" && mode.id === record.id) return (
          <CollectionEditorItem
            key={record.id}
            mode="edit"
            title="Edit managed item"
            onCancel={cancel}
            onSave={save}
            saveDisabled={!draftTitle.trim() || !draftScope.trim()}
          >
            <Field label="Name" htmlFor="collection-edit-name">
              <Input
                id="collection-edit-name"
                controlSize="regular"
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
              />
            </Field>
            <Field label="Scope" htmlFor="collection-edit-scope">
              <Input
                id="collection-edit-scope"
                controlSize="regular"
                value={draftScope}
                onChange={(event) => setDraftScope(event.target.value)}
              />
            </Field>
          </CollectionEditorItem>
        );
        if (mode.kind === "delete" && mode.id === record.id) return (
          <CollectionDeleteItem
            key={record.id}
            title={`Delete “${record.title}”?`}
            description="This action changes the row first; destructive work never fires directly from the trash icon."
            onCancel={cancel}
            onConfirm={() => {
              setRecords((current) => current.filter((item) => item.id !== record.id));
              setMode({ kind: "browse" });
            }}
          />
        );
        return (
          <OperationsItem
            key={record.id}
            presentationLevel="medium"
            controlSize="regular"
            leading={record.type === "claim" ? (
              <Radio className={controlIconClasses.regular} />
            ) : (
              <Link2 className={controlIconClasses.regular} />
            )}
            title={record.title}
            status={(
              <span className="font-utility text-compact font-semibold uppercase tracking-label text-content-muted">
                {record.type}
              </span>
            )}
            actions={(
              <>
                <IconButton
                  label={`Edit ${record.title}`}
                  controlSize="compact"
                  onClick={() => beginEdit(record)}
                >
                  <Pencil className={controlIconClasses.compact} />
                </IconButton>
                <IconButton
                  label={`Delete ${record.title}`}
                  tone="danger"
                  controlSize="compact"
                  onClick={() => setMode({ kind: "delete", id: record.id })}
                >
                  <Trash2 className={controlIconClasses.compact} />
                </IconButton>
              </>
            )}
          />
        );
      })}

      {visibleRecords.length === 0 && mode.kind !== "add" && (
        <CollectionEmptyItem
          query={query}
          onClear={() => setQuery("")}
        />
      )}
    </CollectionManager>
  );
}

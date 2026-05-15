import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiFetch } from "../api";
import type {
  SearchBotHit,
  SearchContext,
  SearchResultsPayload,
  SearchResultType,
  SearchSelection,
} from "../types";
import { AppIcon } from "./icons/AppIcon";
import { FileTypeIcon } from "./icons/FileTypeIcon";
import { MemberListItem } from "./members";

export type SearchPickerHandle = {
  focus: (select?: boolean) => void;
  clear: () => void;
};

export type SearchScopeOption = {
  value: string;
  label: string;
  title?: string;
  marker?: string;
};

export type SearchTypeFilterOption = {
  type: SearchResultType;
  label: string;
};

type SearchPickerProps = {
  context: SearchContext;
  token?: string | null;
  workspaceId?: string | null;
  channelId?: string | null;
  types?: SearchResultType[];
  typeOptions?: SearchTypeFilterOption[];
  placeholder?: string;
  limit?: number;
  keyboardHint?: string;
  enableShortcut?: boolean;
  className?: string;
  modal?: boolean;
  autoFocus?: boolean;
  emptyText?: string;
  actionLabel?: string | ((selection: SearchSelection) => string | null);
  scopeLabel?: string;
  scopeTitle?: string;
  scopeValue?: string;
  scopeOptions?: SearchScopeOption[];
  onScopeChange?: (value: string) => void;
  onSelect: (selection: SearchSelection) => void;
};

const EMPTY_RESULTS: SearchResultsPayload = {
  q: "",
  context: "global_nav",
  workspaces: [],
  channels: [],
  users: [],
  bots: [],
  files: [],
  todos: [],
  tasks: [],
  messages: [],
};

function botScopeText(scope?: SearchBotHit["scope"]) {
  if (scope === "private") return "Private";
  if (scope === "everyone") return "Everyone";
  return "Friend";
}

function botOwnerText(bot: Pick<SearchBotHit, "owner">) {
  return bot.owner?.display_name || bot.owner?.username || "系统";
}

function channelTypeText(type?: string | null) {
  if (type === "private") return "Private";
  return "Workspace";
}

function formatBytes(size?: number | null) {
  if (!size || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function fileTypeText(contentType?: string | null) {
  const ct = contentType || "";
  if (ct.includes("pdf")) return "PDF";
  if (ct.includes("wordprocessingml") || ct.includes("docx")) return "Word";
  if (ct.includes("spreadsheetml") || ct.includes("xlsx")) return "Excel";
  if (ct.startsWith("image/")) return "图片";
  if (ct.startsWith("text/")) return "文本";
  return "文件";
}

function labelFor(selection: SearchSelection) {
  const { type, item } = selection;
  if (type === "workspace") return item.name;
  if (type === "channel") return item.name;
  if (type === "user") return item.display_name || item.username;
  if (type === "bot") return item.display_name || item.username;
  if (type === "file") return item.original_filename || item.file_id;
  if (type === "todo") return item.content;
  if (type === "task") return item.bot_name || item.task_id;
  return item.snippet || item.channel_name;
}

function subFor(selection: SearchSelection) {
  const { type, item } = selection;
  if (type === "workspace") return item.kind === "personal" ? "Personal" : "Workspace";
  if (type === "channel") return channelTypeText(item.type);
  if (type === "user") return item.display_name && item.display_name !== item.username ? `@${item.username}` : "";
  if (type === "bot") return `@${item.username} · ${botScopeText(item.scope)} · Owner: ${botOwnerText(item)}`;
  if (type === "file") {
    const size = formatBytes(item.size_bytes);
    return `${item.channel_name || "频道"} · ${fileTypeText(item.content_type)}${size ? ` · ${size}` : ""}`;
  }
  if (type === "todo") return `${item.channel_name || "频道"} · ${item.status}`;
  if (type === "task") return `${item.channel_name || "频道"} · ${item.task_id}`;
  return `${item.channel_name || "频道"} · ${item.sender_label}`;
}

function sigilFor(type: SearchSelection["type"]) {
  if (type === "workspace") return "□";
  if (type === "channel") return "#";
  if (type === "user") return "@";
  if (type === "bot") return "⦿";
  if (type === "file") return "";
  if (type === "todo") return "✓";
  if (type === "task") return "↯";
  return "#";
}

function groupTitle(type: SearchSelection["type"]) {
  if (type === "workspace") return "工作空间";
  if (type === "channel") return "频道";
  if (type === "user") return "成员";
  if (type === "bot") return "Bot";
  if (type === "file") return "文件";
  if (type === "todo") return "待办";
  if (type === "task") return "任务";
  return "消息";
}

function itemKey(selection: SearchSelection) {
  if (selection.type === "workspace") return `workspace:${selection.item.workspace_id}`;
  if (selection.type === "channel") return `channel:${selection.item.channel_id}`;
  if (selection.type === "user") return `user:${selection.item.user_id}`;
  if (selection.type === "bot") return `bot:${selection.item.bot_id}`;
  if (selection.type === "file") return `file:${selection.item.file_id}`;
  if (selection.type === "todo") return `todo:${selection.item.todo_id}`;
  if (selection.type === "task") return `task:${selection.item.task_id}`;
  return `message:${selection.item.msg_id}`;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const needleLower = needle.toLowerCase();
  const idx = lower.indexOf(needleLower);
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + needle.length)}</mark>
      {text.slice(idx + needle.length)}
    </>
  );
}

function normalizeResults(payload: Partial<SearchResultsPayload> | null | undefined): SearchResultsPayload {
  return {
    ...EMPTY_RESULTS,
    ...(payload || {}),
    workspaces: payload?.workspaces || [],
    channels: payload?.channels || [],
    users: payload?.users || [],
    bots: payload?.bots || [],
    files: payload?.files || [],
    todos: payload?.todos || [],
    tasks: payload?.tasks || [],
    messages: payload?.messages || [],
  };
}

export const SearchPicker = forwardRef<SearchPickerHandle, SearchPickerProps>(
  function SearchPicker(
    {
      context,
      token,
      workspaceId,
      channelId,
      types,
      typeOptions = [],
      placeholder = "搜索",
      limit = 5,
      keyboardHint,
      enableShortcut = false,
      className = "",
      modal = false,
      autoFocus = false,
      emptyText = "没有匹配项",
      actionLabel,
      scopeLabel,
      scopeTitle,
      scopeValue,
      scopeOptions = [],
      onScopeChange,
      onSelect,
    },
    ref,
  ) {
    const [q, setQ] = useState("");
    const [results, setResults] = useState<SearchResultsPayload | null>(null);
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState(false);
    const [scopeOpen, setScopeOpen] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const requestSeqRef = useRef(0);
    const canSwitchScope = Boolean(onScopeChange && scopeOptions.length > 1);
    const typeOptionsKey = typeOptions.map((option) => option.type).join(",");
    const [activeTypes, setActiveTypes] = useState<SearchResultType[]>(
      () => typeOptions.map((option) => option.type),
    );
    const requestTypes = typeOptions.length > 0 ? activeTypes : (types || []);
    const requestTypesKey = requestTypes.join(",");

    useEffect(() => {
      setActiveTypes(typeOptions.map((option) => option.type));
    }, [typeOptionsKey]);

    useImperativeHandle(ref, () => ({
      focus: (select = true) => {
        setOpen(true);
        inputRef.current?.focus();
        if (select) inputRef.current?.select();
      },
      clear: () => {
        setQ("");
        setResults(null);
        setOpen(false);
      },
    }));

    useEffect(() => {
      if (autoFocus) {
        setTimeout(() => inputRef.current?.focus(), 0);
      }
    }, [autoFocus]);

    useEffect(() => {
      if (!enableShortcut) return;
      const onKey = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
          e.preventDefault();
          setScopeOpen(false);
          setOpen(true);
          inputRef.current?.focus();
          inputRef.current?.select();
        } else if (e.key === "Escape" && (open || scopeOpen)) {
          setOpen(false);
          setScopeOpen(false);
          inputRef.current?.blur();
        }
      };
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }, [enableShortcut, open, scopeOpen]);

    useEffect(() => {
      if (!open && !scopeOpen) return;
      const handler = (e: MouseEvent) => {
        if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
          setOpen(false);
          setScopeOpen(false);
        }
      };
      document.addEventListener("mousedown", handler);
      return () => document.removeEventListener("mousedown", handler);
    }, [open, scopeOpen]);

    useEffect(() => {
      const needle = q.trim();
      requestSeqRef.current += 1;
      const requestSeq = requestSeqRef.current;
      if (!needle) {
        setResults(null);
        setBusy(false);
        return;
      }
      setBusy(true);
      const controller = new AbortController();
      const timer = setTimeout(() => {
        const params = new URLSearchParams({
          q: needle,
          context,
          limit: String(limit),
        });
        if (workspaceId) params.set("workspace_id", workspaceId);
        if (channelId) params.set("channel_id", channelId);
        if (requestTypes.length > 0) params.set("types", requestTypes.join(","));
        apiFetch(`search?${params.toString()}`, {
          signal: controller.signal,
          token: token ?? undefined,
        })
          .then((r) => r.json())
          .then((d) => {
            if (requestSeqRef.current === requestSeq) {
              setResults(normalizeResults(d?.data));
            }
          })
          .catch((error) => {
            if ((error as { name?: string }).name === "AbortError") return;
            if (requestSeqRef.current === requestSeq) {
              setResults(normalizeResults(null));
            }
          })
          .finally(() => {
            if (requestSeqRef.current === requestSeq) setBusy(false);
          });
      }, 150);
      return () => {
        controller.abort();
        clearTimeout(timer);
      };
    }, [q, context, limit, token, workspaceId, channelId, requestTypesKey]);

    const groups = useMemo(() => {
      if (!results) return [];
      return [
        { type: "workspace" as const, items: results.workspaces.map((item) => ({ type: "workspace" as const, item })) },
        { type: "channel" as const, items: results.channels.map((item) => ({ type: "channel" as const, item })) },
        { type: "user" as const, items: results.users.map((item) => ({ type: "user" as const, item })) },
        { type: "bot" as const, items: results.bots.map((item) => ({ type: "bot" as const, item })) },
        { type: "file" as const, items: results.files.map((item) => ({ type: "file" as const, item })) },
        { type: "todo" as const, items: results.todos.map((item) => ({ type: "todo" as const, item })) },
        { type: "task" as const, items: results.tasks.map((item) => ({ type: "task" as const, item })) },
        { type: "message" as const, items: results.messages.map((item) => ({ type: "message" as const, item })) },
      ].filter((group) => group.items.length > 0);
    }, [results]);

    const hasHits = groups.length > 0;
    const firstHit = groups[0]?.items[0] as SearchSelection | undefined;

    const choose = (selection: SearchSelection) => {
      onSelect(selection);
      setQ("");
      setResults(null);
      setOpen(false);
      setScopeOpen(false);
    };

    const actionText = (selection: SearchSelection) => {
      if (!actionLabel) return null;
      return typeof actionLabel === "function" ? actionLabel(selection) : actionLabel;
    };

    const searchClasses = [
      "an-search",
      modal ? "in-modal" : "",
      scopeLabel ? "an-search-global" : "",
      scopeLabel && (open || scopeOpen) ? "is-open" : "",
      className,
    ].filter(Boolean).join(" ");
    const scopeDescription = scopeTitle || scopeLabel || "";
    const currentScope = scopeOptions.find((option) => option.value === scopeValue);
    const activeTypeSet = new Set(activeTypes);
    const toggleType = (type: SearchResultType) => {
      setActiveTypes((prev) => {
        if (prev.includes(type)) {
          return prev.length > 1 ? prev.filter((item) => item !== type) : prev;
        }
        return [...prev, type];
      });
      setResults(null);
      setOpen(true);
    };
    const input = (
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && firstHit) {
            e.preventDefault();
            choose(firstHit);
          }
        }}
        placeholder={placeholder}
        aria-label={scopeLabel ? `${placeholder}，当前范围：${scopeLabel}` : placeholder}
      />
    );

    return (
      <div className={searchClasses} ref={wrapRef}>
        {scopeLabel ? (
          <div className="an-search-shell">
            <span className="an-search-ico" aria-hidden="true">
              <AppIcon name="search" />
            </span>
            <button
              type="button"
              className={`an-search-scope ${canSwitchScope ? "is-clickable" : ""} ${scopeOpen ? "is-active" : ""}`}
              title={canSwitchScope ? `${scopeDescription}；点击切换搜索范围` : scopeDescription}
              aria-label={canSwitchScope ? `切换搜索范围，当前范围：${scopeLabel}` : scopeDescription}
              aria-haspopup={canSwitchScope ? "menu" : undefined}
              aria-expanded={canSwitchScope ? scopeOpen : undefined}
              disabled={!canSwitchScope}
              onClick={() => {
                if (!canSwitchScope) return;
                setOpen(false);
                setScopeOpen((v) => !v);
              }}
            >
              <span className="an-search-scope-label">Scope</span>
              {currentScope?.marker && (
                <span className="an-search-scope-marker">{currentScope.marker}</span>
              )}
              <span className="an-search-scope-value">{scopeLabel}</span>
              {canSwitchScope && <AppIcon name="chevronDown" className="an-search-scope-chevron" />}
            </button>
            {input}
            {keyboardHint && <kbd className="an-search-kbd">{keyboardHint}</kbd>}
          </div>
        ) : (
          <>
            <span className="an-search-ico">⌕</span>
            {input}
            {keyboardHint && <kbd className="an-search-kbd">{keyboardHint}</kbd>}
          </>
        )}
        {typeOptions.length > 0 && (
          <div className="an-search-filters" role="group" aria-label="搜索类型">
            {typeOptions.map((option) => {
              const selected = activeTypeSet.has(option.type);
              return (
                <button
                  key={option.type}
                  type="button"
                  className="an-search-filter"
                  data-active={selected ? "1" : undefined}
                  aria-pressed={selected}
                  onClick={() => toggleType(option.type)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        )}
        {scopeOpen && canSwitchScope && (
          <div className="an-search-scope-pop" role="menu">
            {scopeOptions.map((option) => {
              const selected = option.value === scopeValue;
              return (
                <button
                  key={option.value || "__all__"}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className="an-search-scope-option"
                  data-active={selected ? "1" : undefined}
                  title={option.title || option.label}
                  onClick={() => {
                    onScopeChange?.(option.value);
                    setQ("");
                    setResults(null);
                    setScopeOpen(false);
                  }}
                >
                  <span className="an-search-scope-option-mark">{option.marker || "∗"}</span>
                  <span className="an-search-scope-option-text">
                    <span className="an-search-scope-option-name">{option.label}</span>
                    {option.title && (
                      <span className="an-search-scope-option-sub">{option.title}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {open && q.trim() && (
          <div className="an-search-pop" role="listbox">
            {!results && busy && <div className="an-search-empty">搜索中...</div>}
            {results && !hasHits && !busy && (
              <div className="an-search-empty">{emptyText}</div>
            )}
            {groups.map((group) => (
              <div key={group.type}>
                <div className="an-search-group">{groupTitle(group.type)}</div>
                {group.items.map((selection) => {
                  const rich =
                    selection.type === "file" ||
                    selection.type === "message" ||
                    selection.type === "todo" ||
                    selection.type === "task";
                  const sub = subFor(selection);
                  const action = actionText(selection);
                  if (selection.type === "user" || selection.type === "bot") {
                    const label = labelFor(selection);
                    return (
                      <MemberListItem
                        key={itemKey(selection)}
                        id={selection.type === "user" ? selection.item.user_id : selection.item.bot_id}
                        kind={selection.type}
                        username={selection.item.username}
                        displayName={label}
                        name={<Highlight text={label} query={q} />}
                        avatarUrl={selection.item.avatar_url}
                        subtitle={sub}
                        variant="panel"
                        compact
                        asButton
                        className="an-search-hit an-search-member-hit"
                        onClick={() => choose(selection)}
                        actions={action ? <span className="an-search-action">{action}</span> : undefined}
                      />
                    );
                  }
                  return (
                    <button
                      key={itemKey(selection)}
                      type="button"
                      className={`an-search-hit ${rich ? "is-rich" : ""}`}
                      onClick={() => choose(selection)}
                    >
                      {selection.type === "file" ? (
                        <span className="an-search-file-ico">
                          <FileTypeIcon
                            contentType={selection.item.content_type}
                            filename={selection.item.original_filename || selection.item.file_id}
                            size={18}
                          />
                        </span>
                      ) : (
                        <span className="an-search-sigil">{sigilFor(selection.type)}</span>
                      )}
                      <span className="an-search-main">
                        <span className="an-search-name">
                          <Highlight text={labelFor(selection)} query={q} />
                        </span>
                        {sub && <span className="an-search-sub">{sub}</span>}
                        {selection.type === "file" && selection.item.snippet && (
                          <span className="an-search-meta">
                            <Highlight text={selection.item.snippet} query={q} />
                          </span>
                        )}
                        {selection.type === "task" && selection.item.snippet && (
                          <span className="an-search-meta">
                            <Highlight text={selection.item.snippet} query={q} />
                          </span>
                        )}
                        {selection.type === "message" && (
                          <span className="an-search-meta">
                            <Highlight text={selection.item.snippet} query={q} />
                          </span>
                        )}
                      </span>
                      {action && <span className="an-search-action">{action}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  },
);

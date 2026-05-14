import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDownIcon, MagnifyingGlassIcon } from "@heroicons/react/24/solid";
import { apiFetch } from "../api";
import type {
  SearchBotHit,
  SearchContext,
  SearchResultsPayload,
  SearchSelection,
} from "../types";

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

type SearchPickerProps = {
  context: SearchContext;
  token?: string | null;
  workspaceId?: string | null;
  channelId?: string | null;
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

function labelFor(selection: SearchSelection) {
  const { type, item } = selection;
  if (type === "workspace") return item.name;
  if (type === "channel") return item.name;
  if (type === "user") return item.display_name || item.username;
  if (type === "bot") return item.display_name || item.username;
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
  if (type === "todo") return `${item.channel_name || "频道"} · ${item.status}`;
  if (type === "task") return `${item.channel_name || "频道"} · ${item.task_id}`;
  return `${item.channel_name || "频道"} · ${item.sender_label}`;
}

function sigilFor(type: SearchSelection["type"]) {
  if (type === "workspace") return "□";
  if (type === "channel") return "#";
  if (type === "user") return "@";
  if (type === "bot") return "⦿";
  if (type === "todo") return "✓";
  if (type === "task") return "↯";
  return "#";
}

function groupTitle(type: SearchSelection["type"]) {
  if (type === "workspace") return "工作空间";
  if (type === "channel") return "频道";
  if (type === "user") return "成员";
  if (type === "bot") return "Bot";
  if (type === "todo") return "待办";
  if (type === "task") return "任务";
  return "消息";
}

function normalizeResults(payload: Partial<SearchResultsPayload> | null | undefined): SearchResultsPayload {
  return {
    ...EMPTY_RESULTS,
    ...(payload || {}),
    workspaces: payload?.workspaces || [],
    channels: payload?.channels || [],
    users: payload?.users || [],
    bots: payload?.bots || [],
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
    const canSwitchScope = Boolean(onScopeChange && scopeOptions.length > 1);

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
      if (!needle) {
        setResults(null);
        setBusy(false);
        return;
      }
      setBusy(true);
      const timer = setTimeout(() => {
        const params = new URLSearchParams({
          q: needle,
          context,
          limit: String(limit),
        });
        if (workspaceId) params.set("workspace_id", workspaceId);
        if (channelId) params.set("channel_id", channelId);
        apiFetch(`search?${params.toString()}`, { token: token ?? undefined })
          .then((r) => r.json())
          .then((d) => setResults(normalizeResults(d?.data)))
          .catch(() => setResults(normalizeResults(null)))
          .finally(() => setBusy(false));
      }, 150);
      return () => clearTimeout(timer);
    }, [q, context, limit, token, workspaceId, channelId]);

    const groups = useMemo(() => {
      if (!results) return [];
      return [
        { type: "workspace" as const, items: results.workspaces.map((item) => ({ type: "workspace" as const, item })) },
        { type: "channel" as const, items: results.channels.map((item) => ({ type: "channel" as const, item })) },
        { type: "user" as const, items: results.users.map((item) => ({ type: "user" as const, item })) },
        { type: "bot" as const, items: results.bots.map((item) => ({ type: "bot" as const, item })) },
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
              <MagnifyingGlassIcon />
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
              {canSwitchScope && <ChevronDownIcon className="an-search-scope-chevron" />}
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
                    selection.type === "message" ||
                    selection.type === "todo" ||
                    selection.type === "task";
                  const sub = subFor(selection);
                  const action = actionText(selection);
                  return (
                    <button
                      key={`${selection.type}:${selection.type === "workspace" ? selection.item.workspace_id : selection.type === "channel" ? selection.item.channel_id : selection.type === "user" ? selection.item.user_id : selection.type === "bot" ? selection.item.bot_id : selection.type === "todo" ? selection.item.todo_id : selection.type === "task" ? selection.item.task_id : selection.item.msg_id}`}
                      type="button"
                      className={`an-search-hit ${rich ? "is-rich" : ""}`}
                      onClick={() => choose(selection)}
                    >
                      <span className="an-search-sigil">{sigilFor(selection.type)}</span>
                      <span className="an-search-main">
                        <span className="an-search-name">{labelFor(selection)}</span>
                        {sub && <span className="an-search-sub">{sub}</span>}
                        {selection.type === "task" && selection.item.snippet && (
                          <span className="an-search-meta">{selection.item.snippet}</span>
                        )}
                        {selection.type === "message" && (
                          <span className="an-search-meta">{selection.item.snippet}</span>
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

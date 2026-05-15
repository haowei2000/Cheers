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
  SearchContext,
  SearchResultsPayload,
  SearchResultType,
  SearchSelection,
} from "../types";
import { AppIcon } from "./icons/AppIcon";
import { SearchFilters, type SearchTypeFilterOption } from "./search/SearchFilters";
import { SearchResultGroup, type SearchSelectionGroup } from "./search/SearchResultGroup";
import { SearchScopeMenu } from "./search/SearchScopeMenu";

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

export type { SearchTypeFilterOption } from "./search/SearchFilters";

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
    const [settingsOpen, setSettingsOpen] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const requestSeqRef = useRef(0);
    const canSwitchScope = Boolean(onScopeChange && scopeOptions.length > 1);
    const canOpenSettings = Boolean(canSwitchScope || typeOptions.length > 0);
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
          setSettingsOpen(false);
          setOpen(true);
          inputRef.current?.focus();
          inputRef.current?.select();
        } else if (e.key === "Escape" && (open || settingsOpen)) {
          setOpen(false);
          setSettingsOpen(false);
          inputRef.current?.blur();
        }
      };
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }, [enableShortcut, open, settingsOpen]);

    useEffect(() => {
      if (!open && !settingsOpen) return;
      const handler = (e: MouseEvent) => {
        if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
          setOpen(false);
          setSettingsOpen(false);
        }
      };
      document.addEventListener("mousedown", handler);
      return () => document.removeEventListener("mousedown", handler);
    }, [open, settingsOpen]);

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

    const groups = useMemo<SearchSelectionGroup[]>(() => {
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
      setSettingsOpen(false);
    };

    const actionText = (selection: SearchSelection) => {
      if (!actionLabel) return null;
      return typeof actionLabel === "function" ? actionLabel(selection) : actionLabel;
    };

    const searchClasses = [
      "an-search",
      modal ? "in-modal" : "",
      scopeLabel ? "an-search-global" : "",
      scopeLabel && (open || settingsOpen) ? "is-open" : "",
      className,
    ].filter(Boolean).join(" ");
    const scopeDescription = scopeTitle || scopeLabel || "";
    const toggleType = (type: SearchResultType, options?: { showResults?: boolean }) => {
      setActiveTypes((prev) => {
        if (prev.includes(type)) {
          return prev.length > 1 ? prev.filter((item) => item !== type) : prev;
        }
        return [...prev, type];
      });
      setResults(null);
      if (options?.showResults ?? true) {
        setOpen(true);
      }
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
              className={`an-search-scope ${canOpenSettings ? "is-clickable" : ""} ${settingsOpen ? "is-active" : ""}`}
              title={canOpenSettings ? `搜索设置${scopeDescription ? `；${scopeDescription}` : ""}` : scopeDescription}
              aria-label={canOpenSettings ? "搜索设置" : scopeDescription}
              aria-haspopup={canOpenSettings ? "dialog" : undefined}
              aria-expanded={canOpenSettings ? settingsOpen : undefined}
              disabled={!canOpenSettings}
              onClick={() => {
                if (!canOpenSettings) return;
                setOpen(false);
                setSettingsOpen((v) => !v);
              }}
            >
              <AppIcon name="settings" className="an-search-scope-icon" />
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
        {!scopeLabel && (
          <SearchFilters
            options={typeOptions}
            activeTypes={activeTypes}
            onToggle={toggleType}
          />
        )}
        {settingsOpen && canOpenSettings && (
          <SearchScopeMenu
            options={canSwitchScope ? scopeOptions : []}
            value={scopeValue}
            onSelect={(value) => {
              onScopeChange?.(value);
              setQ("");
              setResults(null);
              setSettingsOpen(false);
            }}
            typeOptions={typeOptions}
            activeTypes={activeTypes}
            onTypeToggle={(type) => toggleType(type, { showResults: false })}
          />
        )}
        {open && q.trim() && (
          <div className="an-search-pop" role="listbox">
            {!results && busy && <div className="an-search-empty">搜索中...</div>}
            {results && !hasHits && !busy && (
              <div className="an-search-empty">{emptyText}</div>
            )}
            {groups.map((group) => (
              <SearchResultGroup
                key={group.type}
                group={group}
                query={q}
                actionFor={actionText}
                onSelect={choose}
              />
            ))}
          </div>
        )}
      </div>
    );
  },
);

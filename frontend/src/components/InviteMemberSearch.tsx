import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "../api";

type ApiEnvelope<T> = { status?: string; data?: T; detail?: string; message?: string };

type SearchPayload = {
  users: {
    user_id: string;
    username: string;
    display_name?: string | null;
  }[];
  bots: {
    bot_id: string;
    username: string;
    display_name?: string | null;
    scope?: "private" | "friend" | "everyone";
    owner?: {
      username: string;
      display_name?: string | null;
    } | null;
  }[];
};

type InviteHit = {
  kind: "user" | "bot";
  id: string;
  label: string;
  sub: string;
};

async function parseEnvelope<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as ApiEnvelope<T>;
  if (!res.ok || data.status === "error") {
    throw new Error(data.detail || data.message || `HTTP ${res.status}`);
  }
  return (data.data ?? data) as T;
}

function botScopeText(scope?: "private" | "friend" | "everyone") {
  if (scope === "private") return "Private";
  if (scope === "everyone") return "Everyone";
  return "Friend";
}

export function InviteMemberSearch({
  channelId,
  userToken,
  members,
  canInviteMembers,
  canAddBots,
  onInvited,
  className = "",
}: {
  channelId: string;
  userToken?: string | null;
  members: { member_id: string }[];
  canInviteMembers: boolean;
  canAddBots: boolean;
  onInvited: () => void;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InviteHit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selected, setSelected] = useState<InviteHit | null>(null);

  const memberIds = useMemo(() => new Set(members.map((m) => m.member_id)), [members]);
  const hasInvitePermission = canInviteMembers || canAddBots;
  const placeholder = hasInvitePermission
    ? canInviteMembers && canAddBots
      ? "搜索成员或 Bot"
      : canInviteMembers
        ? "搜索成员"
        : "搜索 Bot"
    : "当前仅管理员可邀请";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (!open || !q || !hasInvitePermission) {
      setResults([]);
      setBusy(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setBusy(true);
      const params = new URLSearchParams({ q, limit: "8" });
      apiFetch(`search?${params.toString()}`, { token: userToken })
        .then((res) => parseEnvelope<SearchPayload>(res))
        .then((data) => {
          if (cancelled) return;
          const hits: InviteHit[] = [];
          if (canInviteMembers) {
            hits.push(
              ...(data.users || [])
                .filter((user) => !memberIds.has(user.user_id))
                .map((user) => ({
                  kind: "user" as const,
                  id: user.user_id,
                  label: user.display_name || user.username,
                  sub: `@${user.username}`,
                })),
            );
          }
          if (canAddBots) {
            hits.push(
              ...(data.bots || [])
                .filter((bot) => !memberIds.has(bot.bot_id))
                .map((bot) => {
                  const owner = bot.owner?.display_name || bot.owner?.username || "系统";
                  return {
                    kind: "bot" as const,
                    id: bot.bot_id,
                    label: bot.display_name || bot.username,
                    sub: `@${bot.username} · ${botScopeText(bot.scope)} · ${owner}`,
                  };
                }),
            );
          }
          setResults(hits);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }, 160);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [canAddBots, canInviteMembers, hasInvitePermission, memberIds, open, query, userToken]);

  const selectHit = (hit: InviteHit) => {
    setSelected(hit);
    setQuery(hit.kind === "bot" ? `@${hit.label}` : hit.label);
    setOpen(false);
  };

  const submit = async () => {
    const raw = query.trim();
    if (!channelId || submitting || !hasInvitePermission) return;
    if (!selected && (!raw || !canInviteMembers)) return;

    setSubmitting(true);
    try {
      if (selected) {
        await parseEnvelope<unknown>(
          await apiFetch(`/channels/${channelId}/members`, {
            method: "POST",
            token: userToken,
            body: {
              member_id: selected.id,
              member_type: selected.kind,
            },
          }),
        );
      } else {
        await parseEnvelope<unknown>(
          await apiFetch(`/channels/${channelId}/invite`, {
            method: "POST",
            token: userToken,
            body: { identifier: raw },
          }),
        );
      }
      toast.success(selected?.kind === "bot" ? "Bot 已加入频道" : "成员已邀请");
      setQuery("");
      setSelected(null);
      setResults([]);
      onInvited();
    } catch (err) {
      toast.error((err as Error).message || "邀请失败");
    } finally {
      setSubmitting(false);
    }
  };

  const submitDisabled =
    submitting ||
    !hasInvitePermission ||
    (!selected && (!query.trim() || !canInviteMembers));

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="an-search min-w-0 flex-1" ref={wrapRef} style={{ margin: 0 }}>
        <span className="an-search-ico">⌕</span>
        <input
          value={query}
          disabled={!hasInvitePermission || submitting}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(null);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          aria-label="邀请成员或 Bot"
        />
        {open && query.trim() && hasInvitePermission && (
          <div className="an-search-pop" role="listbox">
            {busy && <div className="an-search-empty">搜索中…</div>}
            {!busy && results.length === 0 && (
              <div className="an-search-empty">
                {canInviteMembers ? "未找到匹配项，回车可按用户名邀请" : "没有可添加的 Bot"}
              </div>
            )}
            {!busy && results.length > 0 && (
              <>
                <div className="an-search-group">可邀请</div>
                {results.map((hit) => (
                  <button
                    key={`${hit.kind}:${hit.id}`}
                    type="button"
                    className="an-search-hit"
                    onClick={() => selectHit(hit)}
                    role="option"
                  >
                    <span className="an-search-sigil">{hit.kind === "bot" ? "⦿" : "@"}</span>
                    <span className="an-search-name">{hit.label}</span>
                    <span className="an-search-sub">{hit.sub}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={submit}
        disabled={submitDisabled}
        className="an-btn an-btn-primary an-btn-sm"
        style={{ height: 31, padding: "0 12px", flexShrink: 0 }}
      >
        {submitting ? "邀请中…" : "邀请"}
      </button>
    </div>
  );
}

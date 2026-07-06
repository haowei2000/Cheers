import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  UserPlus,
  UserMinus,
  Check,
  X,
  Fingerprint,
  Clock,
  Ban,
} from "lucide-react";
import toast from "react-hot-toast";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/avatar";
import {
  listFriends,
  removeFriend,
  listFriendRequests,
  acceptFriendRequest,
  sendFriendRequest,
  searchUsers,
  blockUser,
  unblockUser,
  listBlocks,
  type Friend,
  type FriendRequestItem,
  type UserSearchResult,
  type BlockedUser,
} from "@/api/friends";

type Tab = "friends" | "requests" | "add" | "blocked";

export default function FriendsPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("friends");
  const [incomingCount, setIncomingCount] = useState(0);

  const refreshIncoming = useCallback(() => {
    listFriendRequests("incoming")
      .then((r) => setIncomingCount(r.length))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshIncoming();
  }, [refreshIncoming]);

  return (
    <div className="h-full bg-zinc-950 text-zinc-100 flex flex-col">
      <header className="flex items-center gap-3 px-4 h-14 border-b border-zinc-800 flex-shrink-0">
        <button
          onClick={() => navigate("/chat")}
          title="Back to chat"
          className="w-8 h-8 max-md:w-11 max-md:h-11 max-md:-ml-2 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 flex items-center justify-center transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="text-base font-semibold">Friends</h1>
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-2xl p-4 max-md:pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <div className="flex gap-1 mb-4 border-b border-zinc-800 overflow-x-auto">
            <TabBtn active={tab === "friends"} onClick={() => setTab("friends")}>
              Friends
            </TabBtn>
            <TabBtn active={tab === "requests"} onClick={() => setTab("requests")}>
              Requests
              {incomingCount > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500/90 text-[10px] font-medium text-white">
                  {incomingCount}
                </span>
              )}
            </TabBtn>
            <TabBtn active={tab === "add"} onClick={() => setTab("add")}>
              Add
            </TabBtn>
            <TabBtn active={tab === "blocked"} onClick={() => setTab("blocked")}>
              Blocked
            </TabBtn>
          </div>

          {tab === "friends" && <FriendsTab />}
          {tab === "requests" && <RequestsTab onChange={refreshIncoming} />}
          {tab === "add" && <AddTab />}
          {tab === "blocked" && <BlockedTab />}
        </div>
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-3 py-2 max-md:py-2.5 text-sm border-b-2 -mb-px transition-colors flex items-center shrink-0 whitespace-nowrap",
        active
          ? "border-indigo-500 text-zinc-100"
          : "border-transparent text-zinc-500 hover:text-zinc-300"
      )}
    >
      {children}
    </button>
  );
}

function FriendsTab() {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    listFriends()
      .then(setFriends)
      .catch(() => toast.error("Failed to load friends"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function remove(f: Friend) {
    try {
      await removeFriend(f.friend_id);
      setFriends((prev) => prev.filter((x) => x.friend_id !== f.friend_id));
      toast.success("Friend removed");
    } catch {
      toast.error("Failed to remove");
    }
  }

  async function block(f: Friend) {
    if (
      !window.confirm(
        `Block ${f.display_name || f.username}? This also removes the friendship.`
      )
    )
      return;
    try {
      await blockUser(f.friend_id);
      setFriends((prev) => prev.filter((x) => x.friend_id !== f.friend_id));
      toast.success("User blocked");
    } catch {
      toast.error("Failed to block");
    }
  }

  if (loading) return <Empty>Loading…</Empty>;
  if (!friends.length)
    return <Empty>No friends yet. Use the Add tab to find people.</Empty>;

  return (
    <div className="space-y-1">
      {friends.map((f) => (
        <Row
          key={f.friendship_id}
          name={f.display_name || f.username}
          sub={`@${f.username}`}
          id={f.friend_id}
          avatar={f.avatar_url}
        >
          <IconBtn title="Block" onClick={() => block(f)} danger>
            <Ban className="w-4 h-4" />
          </IconBtn>
          <IconBtn title="Remove friend" onClick={() => remove(f)} danger>
            <UserMinus className="w-4 h-4" />
          </IconBtn>
        </Row>
      ))}
    </div>
  );
}

function RequestsTab({ onChange }: { onChange: () => void }) {
  const [incoming, setIncoming] = useState<FriendRequestItem[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequestItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      listFriendRequests("incoming"),
      listFriendRequests("outgoing"),
    ])
      .then(([i, o]) => {
        setIncoming(i);
        setOutgoing(o);
      })
      .catch(() => toast.error("Failed to load requests"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function accept(u: FriendRequestItem) {
    try {
      await acceptFriendRequest(u.user_id);
      setIncoming((p) => p.filter((x) => x.user_id !== u.user_id));
      onChange();
      toast.success("Friend request accepted");
    } catch {
      toast.error("Failed to accept");
    }
  }

  async function decline(u: FriendRequestItem, incomingSide: boolean) {
    try {
      await removeFriend(u.user_id);
      if (incomingSide) {
        setIncoming((p) => p.filter((x) => x.user_id !== u.user_id));
        onChange();
      } else {
        setOutgoing((p) => p.filter((x) => x.user_id !== u.user_id));
      }
      toast.success(incomingSide ? "Request declined" : "Request cancelled");
    } catch {
      toast.error("Failed");
    }
  }

  if (loading) return <Empty>Loading…</Empty>;
  if (!incoming.length && !outgoing.length)
    return <Empty>No pending requests.</Empty>;

  return (
    <div className="space-y-5">
      {incoming.length > 0 && (
        <Section title="Incoming">
          {incoming.map((u) => (
            <Row
              key={u.friendship_id}
              name={u.display_name || u.username}
              sub={`@${u.username}`}
              id={u.user_id}
              avatar={u.avatar_url}
            >
              <IconBtn title="Accept" onClick={() => accept(u)} primary>
                <Check className="w-4 h-4" />
              </IconBtn>
              <IconBtn title="Decline" onClick={() => decline(u, true)} danger>
                <X className="w-4 h-4" />
              </IconBtn>
            </Row>
          ))}
        </Section>
      )}
      {outgoing.length > 0 && (
        <Section title="Sent">
          {outgoing.map((u) => (
            <Row
              key={u.friendship_id}
              name={u.display_name || u.username}
              sub={`@${u.username}`}
              id={u.user_id}
              avatar={u.avatar_url}
            >
              <span className="text-xs text-zinc-500 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Pending
              </span>
              <IconBtn title="Cancel request" onClick={() => decline(u, false)} danger>
                <X className="w-4 h-4" />
              </IconBtn>
            </Row>
          ))}
        </Section>
      )}
    </div>
  );
}

// Adding a friend is BY EXACT USER ID only (no name/username search) — the directory
// can't be browsed/enumerated. Paste an id → look it up → confirm → send the request.
function AddTab() {
  const [id, setId] = useState("");
  // null = idle, "none" = looked up but no match, else the single matched user.
  const [result, setResult] = useState<UserSearchResult | null | "none">(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Record<string, string>>({});

  async function lookup() {
    const term = id.trim();
    if (!term) return;
    setBusy(true);
    try {
      const r = await searchUsers(term);
      setResult(r[0] ?? "none");
    } catch {
      setResult("none");
    } finally {
      setBusy(false);
    }
  }

  async function add(u: UserSearchResult) {
    try {
      const res = await sendFriendRequest(u.user_id);
      setSent((s) => ({ ...s, [u.user_id]: res.status }));
      toast.success(
        res.status === "accepted" ? "You're now friends" : "Request sent"
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to send request");
    }
  }

  return (
    <div>
      <p className="text-xs text-zinc-500 mb-2 leading-relaxed">
        Add a friend by their exact <span className="text-zinc-300">user ID</span>. Ask them
        to copy it from <span className="text-zinc-300">Settings → Profile → User ID</span>.
      </p>
      <div className="flex gap-2 mb-3">
        <div className="relative flex-1">
          <Fingerprint className="w-4 h-4 absolute left-3 top-2.5 text-zinc-500" />
          <input
            value={id}
            onChange={(e) => {
              setId(e.target.value);
              setResult(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && lookup()}
            placeholder="Paste a user ID (e.g. b3dbce7e-1f94-…)"
            // text-base (16px) below md prevents iOS Safari's auto-zoom on focus.
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-base md:text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500 transition-colors font-mono"
          />
        </div>
        <button
          onClick={lookup}
          disabled={busy || !id.trim()}
          className="px-3 py-2 rounded-lg bg-indigo-600 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40 transition-colors"
        >
          {busy ? "…" : "Look up"}
        </button>
      </div>
      {result === null ? (
        <Empty>Enter a user ID and press Look up.</Empty>
      ) : result === "none" ? (
        <Empty>No user with that ID.</Empty>
      ) : (
        <div className="space-y-1">
          <Row
            name={result.display_name || result.username}
            sub={`@${result.username}`}
            id={result.user_id}
            avatar={result.avatar_url}
          >
            {sent[result.user_id] === "accepted" ? (
              <span className="text-xs text-emerald-400">Friends</span>
            ) : sent[result.user_id] === "pending" ? (
              <span className="text-xs text-zinc-500">Requested</span>
            ) : (
              <IconBtn title="Add friend" onClick={() => add(result)} primary>
                <UserPlus className="w-4 h-4" />
              </IconBtn>
            )}
          </Row>
        </div>
      )}
    </div>
  );
}

function BlockedTab() {
  const [blocked, setBlocked] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    listBlocks()
      .then(setBlocked)
      .catch(() => toast.error("Failed to load blocked users"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function unblock(u: BlockedUser) {
    try {
      await unblockUser(u.user_id);
      setBlocked((p) => p.filter((x) => x.user_id !== u.user_id));
      toast.success("Unblocked");
    } catch {
      toast.error("Failed to unblock");
    }
  }

  if (loading) return <Empty>Loading…</Empty>;
  if (!blocked.length) return <Empty>No blocked users.</Empty>;
  return (
    <div className="space-y-1">
      {blocked.map((u) => (
        <Row
          key={u.user_id}
          name={u.display_name || u.username}
          sub={`@${u.username}`}
          id={u.user_id}
          avatar={u.avatar_url}
        >
          <button
            onClick={() => unblock(u)}
            className="text-xs px-2.5 py-1 rounded-md border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            Unblock
          </button>
        </Row>
      ))}
    </div>
  );
}

function Row({
  name,
  sub,
  id,
  avatar,
  children,
}: {
  name: string;
  sub: string;
  id?: string;
  avatar?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-zinc-900/60 transition-colors">
      <Avatar name={name} src={avatar ?? undefined} id={id} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-zinc-100 truncate">{name}</div>
        <div className="text-xs text-zinc-500 truncate">{sub}</div>
      </div>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  children,
  primary,
  danger,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        "w-8 h-8 max-md:w-11 max-md:h-11 rounded-md flex items-center justify-center transition-colors",
        primary
          ? "text-emerald-400 hover:bg-emerald-500/10"
          : danger
            ? "text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10"
            : "text-zinc-400 hover:bg-zinc-800"
      )}
    >
      {children}
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1 px-2">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="text-sm text-zinc-500 py-10 text-center">{children}</div>;
}

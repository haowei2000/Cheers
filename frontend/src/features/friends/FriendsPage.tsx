import { InputWithLeadingIcon } from "@/components/ui/input-with-leading-icon";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  UserPlus,
  UserMinus,
  Check,
  X,
  Fingerprint,
  Clock,
  Ban,
  Users,
} from "lucide-react";
import toast from "react-hot-toast";
import { Avatar } from "@/components/ui/avatar";
import { ItemList, ItemRow, ItemSection, NavigationItem } from "@/components/ui/item";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { SurfaceSpinner } from "@/components/ui/spinner";
import { UnreadBadge } from "@/components/ui/unread-badge";
import { isComposing } from "@/lib/ime";
import { RouteChromeHeader } from "@/features/desktop/RouteChromeHeader";
import {
  listFriends,
  removeFriend,
  cancelFriendRequest,
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

const TABS: Array<{ id: Tab; label: string; icon: typeof Users }> = [
  { id: "friends", label: "Friends", icon: Users },
  { id: "requests", label: "Requests", icon: Clock },
  { id: "add", label: "Add", icon: UserPlus },
  { id: "blocked", label: "Blocked", icon: Ban },
];

export default function FriendsPage() {
  const navigate = useNavigate();
  const params = useParams();
  const [incomingCount, setIncomingCount] = useState(0);

  const refreshIncoming = useCallback(() => {
    listFriendRequests("incoming")
      .then((r) => setIncomingCount(r.length))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshIncoming();
  }, [refreshIncoming]);

  const requested = (params["*"] ?? "").split("/")[0];
  const tab: Tab = TABS.some((t) => t.id === requested)
    ? (requested as Tab)
    : "friends";

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-canvas text-content-primary">
      <RouteChromeHeader>
        <header className="mx-auto flex w-full max-w-5xl items-center gap-4 px-6 py-5 max-md:px-4">
          <IconButton
            label="Back to chat"
            onClick={() => navigate("/chat")}
            controlSize="regular"
            className="rounded-sm text-content-primary transition-colors hover:text-content-strong"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          </IconButton>
          <Users className="h-4 w-4 text-accent-400" aria-hidden="true" />
          <div>
            <h1 className="font-serif text-regular font-bold tracking-tight text-content-strong leading-none">Friends</h1>
            <p className="mt-1 hidden text-minimal text-content-muted sm:block">Direct connections and member requests</p>
          </div>
        </header>
      </RouteChromeHeader>

      <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6 max-md:p-4 max-md:pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:flex-row">
        {/* Nav rail */}
        <nav aria-label="Friends sections" className="sm:w-48 sm:shrink-0">
          <ItemList
            presentationLevel="minimal"
            controlSize="regular"
            className="flex gap-1 overflow-x-auto sm:flex-col"
          >
            {TABS.map((item) => {
              const Icon = item.icon;
              const active = tab === item.id;
              return (
                <NavigationItem
                  key={item.id}
                  title={item.label}
                  leading={<Icon className="h-4 w-4" aria-hidden="true" />}
                  selected={active}
                  criticalStatus={
                    item.id === "requests" && incomingCount > 0 ? (
                      <UnreadBadge tone="mention" contentSize="small">
                        {incomingCount}
                      </UnreadBadge>
                    ) : undefined
                  }
                  onClick={() => navigate(item.id === "friends" ? "/friends" : `/friends/${item.id}`)}
                  className="shrink-0 max-sm:w-auto"
                />
              );
            })}
          </ItemList>
        </nav>

        {/* Active section */}
        <main className="min-w-0 flex-1">
          {tab === "friends" && <FriendsTab />}
          {tab === "requests" && <RequestsTab onChange={refreshIncoming} />}
          {tab === "add" && <AddTab />}
          {tab === "blocked" && <BlockedTab />}
        </main>
      </div>
    </div>
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

  if (loading) return <SurfaceSpinner />;
  if (!friends.length)
    return <Empty>No friends yet. Use the Add tab to find people.</Empty>;

  return (
    <ItemList presentationLevel="medium" controlSize="regular" className="space-y-1">
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
    </ItemList>
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
      await cancelFriendRequest(u.friendship_id);
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

  if (loading) return <SurfaceSpinner />;
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
              <span className="text-compact text-content-muted flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
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
  // null = idle, "none" = looked up but no match, "error" = lookup failed,
  // else the single matched user.
  const [result, setResult] = useState<
    UserSearchResult | null | "none" | "error"
  >(null);
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
      // A failed lookup must not masquerade as "no such user" — that would
      // assert a false fact when the real cause is a network/server error.
      setResult("error");
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
      <p className="text-compact text-content-muted mb-2 leading-reading">
        Add a friend by their exact <span className="text-content-secondary">user ID</span>. Ask them
        to copy it from <span className="text-content-secondary">Settings → Profile → User ID</span>.
      </p>
      <div className="flex gap-2 mb-3">
        <InputWithLeadingIcon
          leading={<Fingerprint />}
          containerClassName="flex-1"
          aria-label="User ID"
          value={id}
          onChange={(e) => {
            setId(e.target.value);
            setResult(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && !isComposing(e) && lookup()}
          placeholder="Paste a user ID (e.g. b3dbce7e-1f94-…)"
          controlSize="regular"
          className="bg-zinc-900 font-code"
        />
        <Button action="lookup" aria-label="Look up user ID" loading={busy} onClick={lookup} disabled={!id.trim()} />
      </div>
      {result === null ? (
        <Empty>Enter a user ID and press Look up.</Empty>
      ) : result === "error" ? (
        <div
          role="alert"
          className="text-regular text-danger-400 py-10 text-center"
        >
          Couldn&apos;t look up that ID — check your connection and try again.
        </div>
      ) : result === "none" ? (
        <Empty>No user with that ID.</Empty>
      ) : (
        <ItemList presentationLevel="medium" controlSize="regular" className="space-y-1">
          <Row
            name={result.display_name || result.username}
            sub={`@${result.username}`}
            id={result.user_id}
            avatar={result.avatar_url}
          >
            {sent[result.user_id] === "accepted" ? (
              <span className="text-compact text-success-400">Friends</span>
            ) : sent[result.user_id] === "pending" ? (
              <span className="text-compact text-content-muted">Requested</span>
            ) : (
              <IconBtn title="Add friend" onClick={() => add(result)} primary>
                <UserPlus className="w-4 h-4" />
              </IconBtn>
            )}
          </Row>
        </ItemList>
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

  if (loading) return <SurfaceSpinner />;
  if (!blocked.length) return <Empty>No blocked users.</Empty>;
  return (
    <ItemList presentationLevel="medium" controlSize="regular" className="space-y-1">
      {blocked.map((u) => (
        <Row
          key={u.user_id}
          name={u.display_name || u.username}
          sub={`@${u.username}`}
          id={u.user_id}
          avatar={u.avatar_url}
        >
          <Button variant="secondary"
            action="enable"
            aria-label={`Unblock ${u.display_name || u.username}`}
            onClick={() => unblock(u)}
            controlSize="regular"
          />
        </Row>
      ))}
    </ItemList>
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
    <ItemRow
      kind="identity"
      title={name}
      status={<span className="truncate text-compact text-content-muted">{sub}</span>}
      leading={<Avatar name={name} src={avatar ?? undefined} id={id} size="regular" />}
      actions={<>{children}</>}
      className="gap-3 hover:bg-zinc-900/60"
    />
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
    <IconButton
      label={title}
      onClick={onClick}
      tone={primary ? "success" : danger ? "danger" : "neutral"}
      controlSize="compact"
      className="rounded-sm"
    >
      {children}
    </IconButton>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <ItemSection label={title} presentationLevel="medium" controlSize="regular">
      {children}
    </ItemSection>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="text-regular text-content-muted py-10 text-center">{children}</div>;
}

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  UserPlus,
  UserMinus,
  Check,
  X,
  Clock,
  Ban,
  Users,
  Search,
  MessageSquare,
} from "lucide-react";
import toast from "react-hot-toast";
import { Avatar } from "@/components/ui/avatar";
import { ItemList, ItemRow, ItemSection, NavigationItem } from "@/components/ui/item";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { InputWithLeadingIcon } from "@/components/ui/input-with-leading-icon";
import { SurfaceSpinner } from "@/components/ui/spinner";
import { UnreadBadge } from "@/components/ui/unread-badge";
import { Badge } from "@/components/ui/badge";
import { RouteChromeHeader } from "@/features/desktop/RouteChromeHeader";
import {
  listFriends,
  removeFriend,
  cancelFriendRequest,
  listFriendRequests,
  acceptFriendRequest,
  searchUsers,
  blockUser,
  unblockUser,
  listBlocks,
  type Friend,
  type FriendRequestItem,
  type UserSearchResult,
  type BlockedUser,
} from "@/api/friends";
import { createDm } from "@/api/channels";
import { useChatStore } from "@/stores/chatStore";
import { UserProfileDialog } from "@/components/user/UserProfileDialog";
import { cn } from "@/lib/cn";

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
            <h1 className="font-serif text-regular font-bold tracking-tight text-content-strong leading-none">
              Friends
            </h1>
            <p className="mt-1 hidden text-minimal text-content-muted sm:block">
              Direct connections and member requests
            </p>
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
                  onClick={() =>
                    navigate(item.id === "friends" ? "/friends" : `/friends/${item.id}`)
                  }
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
  const navigate = useNavigate();
  const selectChannel = useChatStore((s) => s.selectChannel);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);
  const [inspectUser, setInspectUser] = useState<Friend | null>(null);

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

  async function startChat(f: Friend) {
    try {
      const dm = await createDm({ target_user_id: f.friend_id });
      selectChannel(dm.channel_id);
      navigate("/chat");
    } catch {
      toast.error("Failed to start chat");
    }
  }

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
    <>
      <ItemList presentationLevel="medium" controlSize="regular" className="space-y-1">
        {friends.map((f) => (
          <Row
            key={f.friendship_id}
            name={f.display_name || f.username}
            sub={`@${f.username}`}
            id={f.friend_id}
            avatar={f.avatar_url}
            message={f.bio}
            isBot={f.is_bot}
            onTitleClick={() => setInspectUser(f)}
          >
            <IconBtn title="Send message" onClick={() => startChat(f)} primary>
              <MessageSquare className="w-4 h-4" />
            </IconBtn>
            <IconBtn title="Remove friend" onClick={() => remove(f)} danger>
              <UserMinus className="w-4 h-4" />
            </IconBtn>
            <IconBtn title="Block" onClick={() => block(f)} danger>
              <Ban className="w-4 h-4" />
            </IconBtn>
          </Row>
        ))}
      </ItemList>

      {inspectUser && (
        <UserProfileDialog
          user={{
            user_id: inspectUser.friend_id,
            username: inspectUser.username,
            display_name: inspectUser.display_name,
            avatar_url: inspectUser.avatar_url,
            bio: inspectUser.bio,
            is_bot: inspectUser.is_bot,
            relationship_status: "friend",
            friendship_id: inspectUser.friendship_id,
          }}
          onClose={() => setInspectUser(null)}
          onRelationshipChanged={load}
        />
      )}
    </>
  );
}

function RequestsTab({ onChange }: { onChange: () => void }) {
  const selectChannel = useChatStore((s) => s.selectChannel);
  const [incoming, setIncoming] = useState<FriendRequestItem[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [inspectUser, setInspectUser] = useState<FriendRequestItem | null>(null);

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
      const res = await acceptFriendRequest(u.user_id, u.target_bot_id || undefined);
      setIncoming((p) => p.filter((x) => x.friendship_id !== u.friendship_id));
      onChange();
      toast.success("Friend request accepted");
      if (res.channel_id) {
        selectChannel(res.channel_id);
      }
    } catch {
      toast.error("Failed to accept");
    }
  }

  async function decline(u: FriendRequestItem, incomingSide: boolean) {
    try {
      await cancelFriendRequest(u.friendship_id);
      if (incomingSide) {
        setIncoming((p) => p.filter((x) => x.friendship_id !== u.friendship_id));
        onChange();
      } else {
        setOutgoing((p) => p.filter((x) => x.friendship_id !== u.friendship_id));
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
              sub={
                u.target_bot_name
                  ? `@${u.username} → 申请添加 Bot: ${u.target_bot_name}`
                  : `@${u.username}`
              }
              id={u.user_id}
              avatar={u.avatar_url}
              message={u.message}
              onTitleClick={() => setInspectUser(u)}
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
              message={u.message}
              isBot={u.is_bot}
              onTitleClick={() => setInspectUser(u)}
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

      {inspectUser && (
        <UserProfileDialog
          user={{
            user_id: inspectUser.user_id,
            username: inspectUser.username,
            display_name: inspectUser.display_name,
            avatar_url: inspectUser.avatar_url,
            is_bot: inspectUser.is_bot,
            relationship_status:
              inspectUser.direction === "incoming" ? "pending_incoming" : "pending_outgoing",
            friendship_id: inspectUser.friendship_id,
          }}
          onClose={() => setInspectUser(null)}
          onRelationshipChanged={() => {
            load();
            onChange();
          }}
        />
      )}
    </div>
  );
}

function AddTab() {
  const navigate = useNavigate();
  const selectChannel = useChatStore((s) => s.selectChannel);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserSearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserSearchResult | null>(null);

  // Debounced live search
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    const timer = setTimeout(() => {
      searchUsers(q)
        .then((res) => {
          setResults(res);
        })
        .catch(() => {
          toast.error("Failed to search users");
          setResults([]);
        })
        .finally(() => {
          setBusy(false);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  async function startChat(userId: string) {
    try {
      const dm = await createDm({ target_user_id: userId });
      selectChannel(dm.channel_id);
      navigate("/chat");
    } catch {
      toast.error("Failed to start chat");
    }
  }

  async function handleAccept(u: UserSearchResult) {
    try {
      const res = await acceptFriendRequest(u.user_id);
      toast.success("Friend request accepted");
      if (res.channel_id) {
        selectChannel(res.channel_id);
      }
      setResults((prev) =>
        prev
          ? prev.map((x) =>
              x.user_id === u.user_id ? { ...x, relationship_status: "friend" } : x
            )
          : null
      );
    } catch {
      toast.error("Failed to accept");
    }
  }

  async function handleCancelRequest(u: UserSearchResult) {
    if (!u.friendship_id) return;
    try {
      await cancelFriendRequest(u.friendship_id);
      toast.success("Request cancelled");
      setResults((prev) =>
        prev
          ? prev.map((x) =>
              x.user_id === u.user_id ? { ...x, relationship_status: "none" } : x
            )
          : null
      );
    } catch {
      toast.error("Failed to cancel request");
    }
  }

  return (
    <div>
      <p className="text-compact text-content-muted mb-2 leading-reading">
        Find people by <span className="text-content-secondary">username</span>,{" "}
        <span className="text-content-secondary">display name</span>, or exact{" "}
        <span className="text-content-secondary">user ID</span>.
      </p>
      <div className="mb-4">
        <InputWithLeadingIcon
          leading={<Search className="h-4 w-4" />}
          containerClassName="w-full"
          aria-label="Search users"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people..."
          controlSize="regular"
          className="bg-zinc-900"
        />
      </div>

      {busy && <SurfaceSpinner />}

      {!busy && results === null && (
        <Empty>Type a name or ID to search for people.</Empty>
      )}

      {!busy && results !== null && results.length === 0 && (
        <Empty>No users found matching &quot;{query}&quot;.</Empty>
      )}

      {!busy && results !== null && results.length > 0 && (
        <ItemList presentationLevel="medium" controlSize="regular" className="space-y-1">
          {results.map((u) => {
            const status = u.relationship_status || "none";
            return (
              <Row
                key={u.user_id}
                name={u.display_name || u.username}
                sub={`@${u.username}`}
                id={u.user_id}
                avatar={u.avatar_url}
                message={u.bio}
                isBot={u.is_bot}
                onTitleClick={() => setSelectedUser(u)}
              >
                {status === "friend" ? (
                  <>
                    <span className="text-compact text-accent-400 font-medium">Friend</span>
                    <IconBtn title="Send message" onClick={() => startChat(u.user_id)} primary>
                      <MessageSquare className="w-4 h-4" />
                    </IconBtn>
                  </>
                ) : status === "pending_outgoing" ? (
                  <>
                    <span className="text-compact text-content-muted flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      Pending
                    </span>
                    <IconBtn title="Cancel request" onClick={() => handleCancelRequest(u)} danger>
                      <X className="w-4 h-4" />
                    </IconBtn>
                  </>
                ) : status === "pending_incoming" ? (
                  <>
                    <IconBtn title="Accept request" onClick={() => handleAccept(u)} primary>
                      <Check className="w-4 h-4" />
                    </IconBtn>
                    <IconBtn title="Decline request" onClick={() => handleCancelRequest(u)} danger>
                      <X className="w-4 h-4" />
                    </IconBtn>
                  </>
                ) : (
                  <Button
                    action="add"
                    variant="primary"
                    controlSize="compact"
                    onClick={() => setSelectedUser(u)}
                  />
                )}
              </Row>
            );
          })}
        </ItemList>
      )}

      {selectedUser && (
        <UserProfileDialog
          user={selectedUser}
          onClose={() => setSelectedUser(null)}
          onRelationshipChanged={() => {
            if (query.trim()) {
              searchUsers(query.trim()).then(setResults).catch(() => {});
            }
          }}
        />
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
          <Button
            variant="secondary"
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
  message,
  isBot,
  onTitleClick,
  children,
}: {
  name: string;
  sub: string;
  id?: string;
  avatar?: string | null;
  message?: string | null;
  isBot?: boolean;
  onTitleClick?: () => void;
  children: ReactNode;
}) {
  return (
    <ItemRow
      kind="identity"
      title={
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "font-medium text-content-strong",
              onTitleClick && "cursor-pointer hover:underline"
            )}
            onClick={onTitleClick}
          >
            {name}
          </span>
          {isBot && (
            <Badge tone="neutral">
              Bot
            </Badge>
          )}
        </div>
      }
      status={<span className="truncate text-compact text-content-muted">{sub}</span>}
      subtitle={
        message ? (
          <span className="block truncate text-compact text-content-secondary/90 italic">
            &quot;{message}&quot;
          </span>
        ) : undefined
      }
      leading={
        <div
          className={cn(onTitleClick && "cursor-pointer")}
          onClick={onTitleClick}
        >
          <Avatar name={name} src={avatar ?? undefined} id={id} size="regular" />
        </div>
      }
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
  return (
    <div className="text-regular text-content-muted py-10 text-center">
      {children}
    </div>
  );
}

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Avatar } from "@/components/ui/avatar";

/** Minimal profile shape the card renders. A channel MemberItem is a superset. */
export interface ProfileData {
  member_id: string;
  member_type?: string; // "user" | "bot"
  display_name?: string | null;
  username?: string | null;
  avatar_url?: string | null;
  bio?: string | null;
  status_text?: string | null;
  status_emoji?: string | null;
  /** When the status was last written (RFC 3339) — powers "updated 3m ago". */
  status_updated_at?: string | null;
  role?: string | null;
  is_online?: boolean | null;
}

/** Compact "updated 3m ago" for a status line. Empty string for a missing/bad date. */
function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

interface Ctx {
  /** Open the card for a fully-known member, anchored to the clicked element. */
  open: (anchor: HTMLElement, member: ProfileData) => void;
  /** Open by id, resolving profile from the provider's member map; `fallback`
   *  fills name/type when the member isn't in the map (e.g. a former member). */
  openById: (
    anchor: HTMLElement,
    id: string,
    fallback?: Partial<ProfileData>
  ) => void;
  /** Look a member up in the provider's live map (e.g. for an avatar_url). */
  memberOf: (id: string) => ProfileData | undefined;
}

const ProfileCtx = createContext<Ctx | null>(null);

/** Null outside a provider — callers guard so an unwrapped tree just isn't clickable. */
export function useProfileCard(): Ctx | null {
  return useContext(ProfileCtx);
}

export function ProfileCardProvider({
  members,
  children,
}: {
  members: Map<string, ProfileData>;
  children: ReactNode;
}) {
  const [state, setState] = useState<{ member: ProfileData; rect: DOMRect } | null>(
    null
  );

  const open = (anchor: HTMLElement, member: ProfileData) =>
    setState({ member, rect: anchor.getBoundingClientRect() });

  const openById = (
    anchor: HTMLElement,
    id: string,
    fallback?: Partial<ProfileData>
  ) => {
    const member =
      members.get(id) ?? { member_id: id, member_type: "user", ...fallback };
    setState({ member, rect: anchor.getBoundingClientRect() });
  };

  // Keep an open card live: `state.member` is a snapshot captured at open time, so a
  // `member_updated` frame that patches the `members` map (avatar/bio/status) would
  // otherwise not reach an already-open card. Prefer the current row from the map;
  // fall back to the snapshot for a member no longer in it (e.g. a former member
  // opened via `openById`'s fallback).
  const liveMember = state
    ? members.get(state.member.member_id) ?? state.member
    : null;

  return (
    <ProfileCtx.Provider value={{ open, openById, memberOf: (id) => members.get(id) }}>
      {children}
      {state && liveMember && (
        <ProfileCard
          member={liveMember}
          rect={state.rect}
          onClose={() => setState(null)}
        />
      )}
    </ProfileCtx.Provider>
  );
}

const CARD_W = 256;

function ProfileCard({
  member,
  rect,
  onClose,
}: {
  member: ProfileData;
  rect: DOMRect;
  onClose: () => void;
}) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-profile-card]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // `capture` so the down-event closes before other handlers re-open it.
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const isBot = member.member_type === "bot";
  const name =
    member.display_name || member.username || member.member_id.slice(0, 8);
  const handle = member.username ? `@${member.username}` : null;

  // Anchor near the clicked element; clamp horizontally, flip above when the
  // click is in the lower half of the viewport so the card stays on-screen.
  const left = Math.min(Math.max(rect.left, 8), window.innerWidth - CARD_W - 8);
  const below = rect.bottom + rect.height / 2 < window.innerHeight / 2;
  const pos: React.CSSProperties = below
    ? { top: rect.bottom + 6, left }
    : { bottom: window.innerHeight - rect.top + 6, left };

  return createPortal(
    <div
      data-profile-card
      style={{ position: "fixed", width: CARD_W, ...pos }}
      className="z-[60] rounded-xl bg-zinc-900 shadow-xl shadow-black/40 overflow-hidden"
    >
      <div className="flex items-start gap-3 p-3">
        <div className="relative flex-shrink-0">
          <Avatar name={name} src={member.avatar_url || undefined} id={member.member_id} size="lg" />
          {member.is_online != null && (
            <span
              className={
                "absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-zinc-900 " +
                (member.is_online ? "bg-emerald-500" : "bg-zinc-600")
              }
              title={member.is_online ? "Online" : "Offline"}
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-zinc-100 truncate">{name}</span>
            {isBot && (
              <span className="text-[10px] px-1 py-0.5 rounded bg-indigo-900/60 text-indigo-300 font-medium">
                BOT
              </span>
            )}
          </div>
          {handle && <p className="text-xs text-zinc-500 truncate">{handle}</p>}
          {(member.status_emoji || member.status_text) && (
            <p className="mt-1 text-xs text-zinc-300 truncate">
              {member.status_emoji && <span className="mr-1">{member.status_emoji}</span>}
              {member.status_text}
            </p>
          )}
          {member.status_updated_at &&
            (member.status_emoji || member.status_text) &&
            relativeTime(member.status_updated_at) && (
              <p className="mt-0.5 text-[10px] text-zinc-500">
                updated {relativeTime(member.status_updated_at)}
              </p>
            )}
        </div>
      </div>

      {member.bio && (
        <div className="border-t border-zinc-800 px-3 py-2">
          <p className="text-xs text-zinc-400 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
            {member.bio}
          </p>
        </div>
      )}
      {member.role && member.role !== "member" && (
        <div className="border-t border-zinc-800 px-3 py-1.5">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">
            {member.role}
          </span>
        </div>
      )}
    </div>,
    document.body
  );
}

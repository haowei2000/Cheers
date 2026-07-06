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
  role?: string | null;
  is_online?: boolean | null;
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

  return (
    <ProfileCtx.Provider value={{ open, openById }}>
      {children}
      {state && (
        <ProfileCard
          member={state.member}
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
      className="z-[60] rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl overflow-hidden"
    >
      <div className="flex items-start gap-3 p-3">
        <div className="relative flex-shrink-0">
          <Avatar name={name} src={member.avatar_url || undefined} id={member.member_id} size="lg" />
          {member.is_online != null && (
            <span
              className={
                "absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-zinc-900 " +
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

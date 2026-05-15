import { useEffect, useState, type ReactNode } from "react";
import type { CurrentUser } from "../types";
import { apiFetch } from "../api";
import { AppIcon } from "./icons";
import { Modal } from "./Modal";
import { AccountPane, KeychainPane } from "../features/settings/account/AccountPane";
import { AppearancePane } from "../features/settings/appearance/AppearancePane";
import { BulletinPane } from "../features/settings/bulletin/BulletinPane";
import { BotPane, type BotRow } from "../features/settings/bots/BotPane";
import { FriendsPane } from "../features/settings/friends/FriendsPane";
import {
  applyDensity,
  DENSITY_KEY,
  getStoredDensity,
  type Density,
} from "../lib/density";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  isDark: boolean;
  setTheme: (t: "light" | "dark") => void;
  authToken: string | null;
  currentUser: CurrentUser;
  onProfileUpdated: (data: { display_name: string; bio?: string | null; avatar_url?: string | null }) => void;
  onOpenDM?: (memberId: string, memberType: "user" | "bot") => void;
  onLogout: () => void;
}

/** One pane per top-level category. Drill-down within a category (e.g.
 *  selecting a specific bot inside the Bot pane) is local state on that
 *  pane, not a separate sidebar entry. */
type Pane = "bot" | "account" | "friends" | "appearance" | "bulletin" | "other";

export function SettingsModal({
  open,
  onClose,
  isDark,
  setTheme,
  authToken,
  currentUser,
  onProfileUpdated,
  onOpenDM,
  onLogout,
}: SettingsModalProps) {
  const [pane, setPane] = useState<Pane>("bot");
  const [density, setDensityState] = useState<Density>(() => getStoredDensity());
  const [bots, setBots] = useState<BotRow[]>([]);
  const canManageBuiltinBots = currentUser?.role === "system_admin";
  const visibleBots = bots.filter(
    (b) =>
      b.can_manage ||
      b.created_by === currentUser?.user_id ||
      (canManageBuiltinBots && b.is_builtin),
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const reloadBots = () => {
    apiFetch("/bots", { token: authToken })
      .then((r) => r.json())
      .then((d) => setBots(Array.isArray(d?.data) ? d.data : []))
      .catch(() => setBots([]));
  };

  useEffect(() => {
    if (!open) return;
    reloadBots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, authToken]);

  const changeDensity = (d: Density) => {
    setDensityState(d);
    localStorage.setItem(DENSITY_KEY, d);
    applyDensity(d);
  };

  const NAV_ITEMS: { id: Pane; ico: ReactNode; label: string }[] = [
    { id: "bot", ico: "◉", label: "Bot" },
    { id: "account", ico: "◉", label: "账户" },
    { id: "friends", ico: "◎", label: "好友" },
    { id: "appearance", ico: "◐", label: "外观" },
    {
      id: "bulletin",
      ico: <AppIcon name="messageCircle" className="inline-block w-3.5 h-3.5 align-text-bottom" />,
      label: "留言板",
    },
    { id: "other", ico: "⌘", label: "其他" },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="设置 · Settings"
      maxWidth="max-w-3xl"
      panelClassName="overflow-hidden"
    >
      <div className="an-modal-body -mx-5 -my-4">
        <nav className="an-settings-nav">
          {NAV_ITEMS.map((it) => (
            <button
              key={it.id}
              type="button"
              className={`an-sn-item ${pane === it.id ? "on" : ""}`}
              onClick={() => setPane(it.id)}
            >
              <span className="an-sn-ico">{it.ico}</span> {it.label}
            </button>
          ))}
        </nav>
        <div className="an-settings-pane">
          {pane === "bot" && (
            <BotPane
              bots={visibleBots}
              authToken={authToken}
              onChanged={reloadBots}
            />
          )}
          {pane === "account" && (
            <AccountPane
              currentUser={currentUser}
              authToken={authToken}
              onProfileUpdated={onProfileUpdated}
              onLogout={() => {
                onClose();
                onLogout();
              }}
            />
          )}
          {pane === "friends" && (
            <FriendsPane
              currentUserId={currentUser?.user_id || ""}
              authToken={authToken}
              onOpenDM={onOpenDM}
            />
          )}
          {pane === "appearance" && (
            <AppearancePane
              isDark={isDark}
              setTheme={setTheme}
              density={density}
              setDensity={changeDensity}
            />
          )}
          {pane === "bulletin" && (
            <BulletinPane
              authToken={authToken}
              currentUserId={currentUser?.user_id || ""}
              userRole={currentUser?.role || ""}
            />
          )}
          {pane === "other" && authToken && (
            <KeychainPane authToken={authToken} />
          )}
        </div>
      </div>
    </Modal>
  );
}

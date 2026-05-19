import { useEffect, useState } from "react";
import type { CurrentUser } from "../types";
import { apiFetch } from "../api";
import { AppIcon, type AppIconName } from "./icons";
import { Modal } from "./Modal";
import { AccountPane, KeychainPane } from "../features/settings/account/AccountPane";
import { AppearancePane } from "../features/settings/appearance/AppearancePane";
import { BulletinPane } from "../features/settings/bulletin/BulletinPane";
import { BotListSubPane } from "../features/settings/bots/BotListSubPane";
import type { BotRow } from "../features/settings/bots/types";
import { FriendsPane } from "../features/settings/friends/FriendsPane";
import { ModelListSubPane } from "../features/settings/models/ModelListSubPane";
import { TemplateListSubPane } from "../features/settings/templates/TemplateListSubPane";
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
  beginnerMode: boolean;
  setBeginnerMode: (enabled: boolean) => void;
  authToken: string | null;
  currentUser: CurrentUser;
  onProfileUpdated: (data: { display_name: string; bio?: string | null; avatar_url?: string | null }) => void;
  onOpenDM?: (memberId: string, memberType: "user" | "bot") => void;
  onLogout: () => void;
}

type SettingsRoute =
  | "bots"
  | "templates"
  | "models"
  | "account"
  | "friends"
  | "keychain"
  | "appearance"
  | "bulletin";

type SettingsNavItem = {
  id: SettingsRoute;
  icon: AppIconName;
  label: string;
  hint: string;
};

type SettingsNavGroup = {
  label: string;
  items: SettingsNavItem[];
};

const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    label: "Agents",
    items: [
      { id: "bots", icon: "bot", label: "Bot", hint: "Accounts and status" },
      { id: "templates", icon: "note", label: "Template", hint: "Prompt reuse" },
      { id: "models", icon: "model", label: "Models", hint: "LLM Provider" },
    ],
  },
  {
    label: "Personal",
    items: [
      { id: "account", icon: "user", label: "Account", hint: "Profile and password" },
      { id: "friends", icon: "userPlus", label: "Friends", hint: "Relationships and requests" },
      { id: "keychain", icon: "key", label: "Keychain", hint: "Secret references" },
    ],
  },
  {
    label: "Interface",
    items: [
      { id: "appearance", icon: "palette", label: "Appearance", hint: "Topics and density" },
    ],
  },
  {
    label: "Feedback",
    items: [
      { id: "bulletin", icon: "messageCircle", label: "Bulletin", hint: "Feedback and records" },
    ],
  },
];

export function SettingsModal({
  open,
  onClose,
  isDark,
  setTheme,
  beginnerMode,
  setBeginnerMode,
  authToken,
  currentUser,
  onProfileUpdated,
  onOpenDM,
  onLogout,
}: SettingsModalProps) {
  const [route, setRoute] = useState<SettingsRoute>("bots");
  const [density, setDensityState] = useState<Density>(() => getStoredDensity());
  const [bots, setBots] = useState<BotRow[]>([]);
  const [botsLoading, setBotsLoading] = useState(false);
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
    setBotsLoading(true);
    apiFetch("/bots", { token: authToken })
      .then((r) => r.json())
      .then((d) => setBots(Array.isArray(d?.data) ? d.data : []))
      .catch(() => setBots([]))
      .finally(() => setBotsLoading(false));
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settings"
      maxWidth="max-w-4xl"
      panelClassName="overflow-hidden"
    >
      <div className="an-modal-body -mx-5 -my-4">
        <nav className="an-settings-nav" aria-label="Settings navigation">
          {SETTINGS_NAV.map((group) => (
            <div key={group.label} className="an-sn-group">
              <div className="an-sn-group-title">{group.label}</div>
              {group.items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  className={`an-sn-item ${route === it.id ? "on" : ""}`}
                  onClick={() => setRoute(it.id)}
                  title={`${it.label} · ${it.hint}`}
                  aria-current={route === it.id ? "page" : undefined}
                >
                  <span className="an-sn-ico">
                    <AppIcon name={it.icon} />
                  </span>
                  <span className="an-sn-copy">
                    <span className="an-sn-label">{it.label}</span>
                    <span className="an-sn-hint">{it.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="an-settings-pane">
          {route === "bots" && (
            <BotListSubPane
              bots={visibleBots}
              loading={botsLoading}
              authToken={authToken}
              onChanged={reloadBots}
            />
          )}
          {route === "templates" && <TemplateListSubPane authToken={authToken} />}
          {route === "models" && <ModelListSubPane authToken={authToken} />}
          {route === "account" && (
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
          {route === "friends" && (
            <FriendsPane
              currentUserId={currentUser?.user_id || ""}
              authToken={authToken}
              onOpenDM={onOpenDM}
            />
          )}
          {route === "appearance" && (
            <AppearancePane
              isDark={isDark}
              setTheme={setTheme}
              density={density}
              setDensity={changeDensity}
              beginnerMode={beginnerMode}
              setBeginnerMode={setBeginnerMode}
            />
          )}
          {route === "bulletin" && (
            <BulletinPane
              authToken={authToken}
              currentUserId={currentUser?.user_id || ""}
              userRole={currentUser?.role || ""}
            />
          )}
          {route === "keychain" && authToken && (
            <KeychainPane authToken={authToken} />
          )}
          {route === "keychain" && !authToken && (
            <div className="an-pane">
              <div className="an-pane-head">
                <div>
                  <div className="an-pane-title">Keychain</div>
                  <div className="an-pane-sub">Sign in to manage secret references.</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

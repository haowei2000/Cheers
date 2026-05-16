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
    label: "智能体",
    items: [
      { id: "bots", icon: "bot", label: "Bot", hint: "账号与状态" },
      { id: "templates", icon: "note", label: "模板", hint: "Prompt 复用" },
      { id: "models", icon: "model", label: "模型", hint: "LLM Provider" },
    ],
  },
  {
    label: "个人",
    items: [
      { id: "account", icon: "user", label: "账户", hint: "资料与密码" },
      { id: "friends", icon: "userPlus", label: "好友", hint: "关系与申请" },
      { id: "keychain", icon: "key", label: "钥匙链", hint: "密钥引用" },
    ],
  },
  {
    label: "界面",
    items: [
      { id: "appearance", icon: "palette", label: "外观", hint: "主题与密度" },
    ],
  },
  {
    label: "反馈",
    items: [
      { id: "bulletin", icon: "messageCircle", label: "留言板", hint: "反馈与记录" },
    ],
  },
];

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
  const [route, setRoute] = useState<SettingsRoute>("bots");
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="设置 · Settings"
      maxWidth="max-w-4xl"
      panelClassName="overflow-hidden"
    >
      <div className="an-modal-body -mx-5 -my-4">
        <nav className="an-settings-nav" aria-label="设置导航">
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
                  <div className="an-pane-title">钥匙链</div>
                  <div className="an-pane-sub">登录后可管理密钥引用。</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

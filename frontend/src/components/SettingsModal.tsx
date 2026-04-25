import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { CurrentUser } from "../types";
import { apiFetch } from "../api";

type Density = "comfy" | "compact";
type AccentId = "indigo" | "teal" | "amber" | "rose" | "blue";

const ACCENTS: { id: AccentId; c: string; label: string }[] = [
  { id: "indigo", c: "#7c6cf5", label: "Indigo" },
  { id: "teal", c: "#3ecf8e", label: "Teal" },
  { id: "amber", c: "#f5a623", label: "Amber" },
  { id: "rose", c: "#f05478", label: "Rose" },
  { id: "blue", c: "#56a7ff", label: "Blue" },
];

const DENSITY_KEY = "agentnexus-density";
const ACCENT_KEY = "agentnexus-accent";

export function getStoredDensity(): Density {
  if (typeof window === "undefined") return "comfy";
  const v = localStorage.getItem(DENSITY_KEY);
  return v === "compact" ? "compact" : "comfy";
}

export function getStoredAccent(): AccentId {
  if (typeof window === "undefined") return "indigo";
  const v = localStorage.getItem(ACCENT_KEY) as AccentId | null;
  return ACCENTS.some((a) => a.id === v) ? (v as AccentId) : "indigo";
}

export function applyAccent(id: AccentId) {
  const hit = ACCENTS.find((a) => a.id === id) || ACCENTS[0];
  const root = document.documentElement.style;
  root.setProperty("--accent", hit.c);
  root.setProperty("--accent-hover", hit.c);
  root.setProperty("--accent-muted", hit.c + "24");
  root.setProperty("--accent-ring", hit.c + "66");
  root.setProperty("--border-focus", hit.c + "99");
}

export function applyDensity(d: Density) {
  document.documentElement.setAttribute("data-density", d);
}

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  isDark: boolean;
  setTheme: (t: "light" | "dark") => void;
  authToken: string | null;

  currentUser: CurrentUser;
  onOpenUserProfile: () => void;
  onOpenKeychain: () => void;
  onOpenFriends: () => void;
  onLogout: () => void;
}

type BotRow = {
  bot_id: string;
  username: string;
  display_name?: string | null;
};

/** Right pane: only views that have content of their own.
 *  Action-only entries (new bot, logout, open keychain, …) close the
 *  modal and run their handler, so they don't need a pane. */
type Pane = "appearance";

export function SettingsModal({
  open,
  onClose,
  isDark,
  setTheme,
  authToken,
  currentUser,
  onOpenUserProfile,
  onOpenKeychain,
  onOpenFriends,
  onLogout,
}: SettingsModalProps) {
  const [pane, setPane] = useState<Pane>("appearance");
  const [density, setDensityState] = useState<Density>(() => getStoredDensity());
  const [accent, setAccentState] = useState<AccentId>(() => getStoredAccent());
  const [bots, setBots] = useState<BotRow[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    apiFetch("/bots", { token: authToken })
      .then((r) => r.json())
      .then((d) => setBots(Array.isArray(d?.data) ? d.data : []))
      .catch(() => setBots([]));
  }, [open, authToken]);

  const changeDensity = (d: Density) => {
    setDensityState(d);
    localStorage.setItem(DENSITY_KEY, d);
    applyDensity(d);
  };

  const changeAccent = (id: AccentId) => {
    setAccentState(id);
    localStorage.setItem(ACCENT_KEY, id);
    applyAccent(id);
  };

  const closeAndRun = (fn: () => void) => {
    onClose();
    fn();
  };

  const closeAndGo = (path: string) => {
    onClose();
    navigate(path);
  };

  if (!open) return null;

  return (
    <div className="an-modal-overlay" onClick={onClose}>
      <div className="an-modal" onClick={(e) => e.stopPropagation()}>
        <div className="an-modal-head">
          <div className="an-modal-title">设置 · Settings</div>
          <button
            type="button"
            className="an-modal-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <div className="an-modal-body">
          <nav className="an-settings-nav">
            <NavGroup label="Bot">
              <NavLeaf
                active={false}
                onClick={() => closeAndGo("/admin")}
              >
                <span className="an-sn-ico">＋</span> 新建 Bot
              </NavLeaf>
              {bots.map((b) => (
                <NavLeaf
                  key={b.bot_id}
                  active={false}
                  onClick={() => closeAndGo("/admin")}
                >
                  <span className="an-sn-ico">◉</span>{" "}
                  {b.display_name || b.username || b.bot_id.slice(0, 6)}
                </NavLeaf>
              ))}
              {bots.length === 0 && (
                <div
                  style={{
                    padding: "6px 16px 6px 36px",
                    fontSize: 11,
                    color: "var(--fg-3)",
                  }}
                >
                  暂无 Bot
                </div>
              )}
            </NavGroup>

            <NavGroup label="账户">
              <NavLeaf
                active={false}
                onClick={() => closeAndRun(onOpenUserProfile)}
                disabled={!currentUser}
              >
                <span className="an-sn-ico">◉</span> 编辑资料
              </NavLeaf>
              <NavLeaf
                active={false}
                onClick={() => closeAndRun(onLogout)}
                disabled={!currentUser}
                danger
              >
                <span className="an-sn-ico">↗</span> 退出登录
              </NavLeaf>
            </NavGroup>

            <NavRoot
              active={false}
              onClick={() => closeAndRun(onOpenFriends)}
            >
              <span className="an-sn-ico">◎</span> 好友
            </NavRoot>

            <NavRoot
              active={pane === "appearance"}
              onClick={() => setPane("appearance")}
            >
              <span className="an-sn-ico">◐</span> 外观
            </NavRoot>

            <NavRoot
              active={false}
              onClick={() => closeAndGo("/bulletin")}
            >
              <span className="an-sn-ico">💬</span> 留言板
            </NavRoot>

            <NavGroup label="其他">
              <NavLeaf
                active={false}
                onClick={() => closeAndRun(onOpenKeychain)}
              >
                <span className="an-sn-ico">⌘</span> 钥匙链
              </NavLeaf>
            </NavGroup>
          </nav>
          <div className="an-settings-pane">
            {pane === "appearance" && (
              <AppearancePane
                isDark={isDark}
                setTheme={setTheme}
                density={density}
                setDensity={changeDensity}
                accent={accent}
                setAccent={changeAccent}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function NavRoot({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`an-sn-item ${active ? "on" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function NavGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="an-sn-group">
      <div
        style={{
          padding: "10px 16px 4px",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.8px",
          textTransform: "uppercase",
          color: "var(--fg-3)",
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function NavLeaf({
  active,
  onClick,
  disabled,
  danger,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`an-sn-item ${active ? "on" : ""}`}
      style={{
        paddingLeft: 28,
        opacity: disabled ? 0.45 : undefined,
        color: danger ? "var(--red)" : undefined,
        cursor: disabled ? "not-allowed" : undefined,
      }}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function AppearancePane({
  isDark,
  setTheme,
  density,
  setDensity,
  accent,
  setAccent,
}: {
  isDark: boolean;
  setTheme: (t: "light" | "dark") => void;
  density: Density;
  setDensity: (d: Density) => void;
  accent: AccentId;
  setAccent: (id: AccentId) => void;
}) {
  return (
    <div>
      <div className="an-pane-head">
        <div>
          <div className="an-pane-title">外观</div>
          <div className="an-pane-sub">主题、密度与主色。</div>
        </div>
      </div>
      <div className="an-list-table">
        <div className="an-row-card" style={{ justifyContent: "space-between" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="an-rc-title">主题</div>
            <div className="an-rc-sub">整体亮度。</div>
          </div>
          <div className="an-seg">
            <button
              type="button"
              className={isDark ? "on" : ""}
              onClick={() => setTheme("dark")}
            >
              深色
            </button>
            <button
              type="button"
              className={!isDark ? "on" : ""}
              onClick={() => setTheme("light")}
            >
              浅色
            </button>
          </div>
        </div>
        <div className="an-row-card" style={{ justifyContent: "space-between" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="an-rc-title">密度</div>
            <div className="an-rc-sub">消息间距。</div>
          </div>
          <div className="an-seg">
            <button
              type="button"
              className={density === "comfy" ? "on" : ""}
              onClick={() => setDensity("comfy")}
            >
              舒适
            </button>
            <button
              type="button"
              className={density === "compact" ? "on" : ""}
              onClick={() => setDensity("compact")}
            >
              紧凑
            </button>
          </div>
        </div>
        <div className="an-row-card" style={{ justifyContent: "space-between" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="an-rc-title">主色</div>
            <div className="an-rc-sub">按钮、高亮与链接的主色。</div>
          </div>
          <div className="an-swatch-row">
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`an-sw ${accent === a.id ? "on" : ""}`}
                style={{ background: a.c }}
                onClick={() => setAccent(a.id)}
                aria-label={a.label}
                title={a.label}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

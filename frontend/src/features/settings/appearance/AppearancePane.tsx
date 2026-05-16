import type { Density } from "../../../lib/density";
import { LanguageSwitcher } from "../../../i18n";

// ── Appearance pane ───────────────────────────────────────────────────────

export function AppearancePane({
  isDark,
  setTheme,
  density,
  setDensity,
}: {
  isDark: boolean;
  setTheme: (t: "light" | "dark") => void;
  density: Density;
  setDensity: (d: Density) => void;
}) {
  return (
    <div className="an-pane">
      <div className="an-pane-head">
        <div>
          <div className="an-pane-title">外观</div>
          <div className="an-pane-sub">主题、密度与语言。</div>
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
            <div className="an-rc-title">语言</div>
            <div className="an-rc-sub">界面显示语言。</div>
          </div>
          <LanguageSwitcher hideLabel />
        </div>
      </div>
    </div>
  );
}

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
          <div className="an-pane-title">Appearance</div>
          <div className="an-pane-sub">Topics, density, and language.</div>
        </div>
      </div>
      <div className="an-list-table">
        <div className="an-row-card" style={{ justifyContent: "space-between" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="an-rc-title">Topics</div>
            <div className="an-rc-sub">Overall brightness.</div>
          </div>
          <div className="an-seg">
            <button
              type="button"
              className={isDark ? "on" : ""}
              onClick={() => setTheme("dark")}
            >
              Dark
            </button>
            <button
              type="button"
              className={!isDark ? "on" : ""}
              onClick={() => setTheme("light")}
            >
              Light
            </button>
          </div>
        </div>
        <div className="an-row-card" style={{ justifyContent: "space-between" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="an-rc-title">Density</div>
            <div className="an-rc-sub">Message spacing.</div>
          </div>
          <div className="an-seg">
            <button
              type="button"
              className={density === "comfy" ? "on" : ""}
              onClick={() => setDensity("comfy")}
            >
              Comfortable
            </button>
            <button
              type="button"
              className={density === "compact" ? "on" : ""}
              onClick={() => setDensity("compact")}
            >
              Compact
            </button>
          </div>
        </div>
        <div className="an-row-card" style={{ justifyContent: "space-between" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="an-rc-title">Language</div>
            <div className="an-rc-sub">Interface display language.</div>
          </div>
          <LanguageSwitcher hideLabel />
        </div>
      </div>
    </div>
  );
}

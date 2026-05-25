import type { Density } from "../../../lib/density";
import { LanguageSwitcher } from "../../../i18n";

// ── Appearance pane ───────────────────────────────────────────────────────

export function AppearancePane({
  isDark,
  setTheme,
  density,
  setDensity,
  beginnerMode,
  setBeginnerMode,
}: {
  isDark: boolean;
  setTheme: (t: "light" | "dark") => void;
  density: Density;
  setDensity: (d: Density) => void;
  beginnerMode: boolean;
  setBeginnerMode: (enabled: boolean) => void;
}) {
  return (
    <div className="an-pane">
      <div className="an-pane-head">
        <div>
          <div className="an-pane-title">Appearance</div>
          <div className="an-pane-sub">Topics, density, language, and guided defaults.</div>
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
        <div className="an-row-card" style={{ justifyContent: "space-between" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="an-rc-title">Beginner mode</div>
            <div className="an-rc-sub">
              Fewer choices. Group tasks create a private channel and invite every bot you can use.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={beginnerMode}
            aria-label="Beginner mode"
            onClick={() => setBeginnerMode(!beginnerMode)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
              beginnerMode ? "bg-[var(--accent)]" : "bg-[var(--bg-2)]"
            }`}
            style={{ border: "1px solid var(--border)" }}
          >
            <span
              className="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform"
              style={{ transform: beginnerMode ? "translateX(22px)" : "translateX(4px)" }}
            />
          </button>
        </div>
      </div>
    </div>
  );
}

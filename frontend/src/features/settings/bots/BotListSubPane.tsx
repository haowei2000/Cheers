import { useState } from "react";
import { BotAvatar } from "../../../components/BotAvatar";
import { AppIcon } from "../../../components/icons";
import { Tooltip } from "../../../components/Tooltip";
import { BackBar } from "../shared/SettingsControls";
import { BotEditPane } from "./BotEditPane";
import { BotNewPane } from "./BotNewPane";
import { BotOnlineBadge, botOwnerLabel, botScopeLabel } from "./BotShared";
import type { BotRow } from "./types";

export function BotListSubPane({
  bots,
  authToken,
  onChanged,
}: {
  bots: BotRow[];
  authToken: string | null;
  onChanged: () => void;
}) {
  const [view, setView] = useState<"list" | "new" | { botId: string }>("list");

  if (view === "new") {
    return (
      <div className="an-pane">
        <BackBar label="返回 Bot 列表" onBack={() => setView("list")} />
        <BotNewPane
          authToken={authToken}
          onCreated={(b) => {
            onChanged();
            setView({ botId: b.bot_id });
          }}
        />
      </div>
    );
  }

  if (typeof view === "object") {
    const bot = bots.find((b) => b.bot_id === view.botId);
    if (!bot) {
      return (
        <div className="an-pane">
          <BackBar label="返回 Bot 列表" onBack={() => setView("list")} />
          <div className="an-row-card" style={{ color: "var(--fg-3)" }}>
            该 Bot 已不存在
          </div>
        </div>
      );
    }
    return (
      <div className="an-pane">
        <BackBar label="返回 Bot 列表" onBack={() => setView("list")} />
        <BotEditPane
          bot={bot}
          authToken={authToken}
          onUpdated={onChanged}
          onDeleted={() => {
            onChanged();
            setView("list");
          }}
        />
      </div>
    );
  }

  return (
    <div className="an-pane">
      <div className="an-pane-head">
        <div>
          <div className="an-pane-title">Bot</div>
          <div className="an-pane-sub">{bots.length} 个可管理 Bot</div>
        </div>
        <Tooltip content="刷新 Bot 在线状态" placement="left">
          <button
            type="button"
            className="an-btn an-btn-icon"
            onClick={onChanged}
            aria-label="刷新 Bot 在线状态"
          >
            <AppIcon name="refresh" />
          </button>
        </Tooltip>
      </div>
      <div className="an-list-table">
        <button
          type="button"
          className="an-row-card"
          style={{ width: "100%", textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}
          onClick={() => setView("new")}
        >
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: 6,
              background: "var(--surface-soft)",
              color: "var(--accent)",
              display: "inline-grid",
              placeItems: "center",
              flexShrink: 0,
            }}
          >
            <AppIcon name="plus" className="h-4 w-4" />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="an-rc-title">新建 Bot</div>
            <div className="an-rc-sub">模型 + 模板</div>
          </div>
          <AppIcon name="chevronRight" className="an-rc-chev" />
        </button>
        {bots.length === 0 ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>
            暂无 Bot
          </div>
        ) : (
          bots.map((b) => (
            <button
              key={b.bot_id}
              type="button"
              className="an-row-card"
              style={{ width: "100%", textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}
              onClick={() => setView({ botId: b.bot_id })}
            >
              <BotAvatar
                label={b.display_name || b.username || "Bot"}
                avatarUrl={b.avatar_url}
                brandName={b.model_name || b.display_name || b.username}
                size={32}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="an-rc-title">{b.display_name || b.username}</div>
                <Tooltip
                  content={`@${b.username} · ${(b.binding_type || "http") === "agent_bridge" ? "WebSocket" : "HTTP"} · ${botScopeLabel(b.scope)} · Owner: ${botOwnerLabel(b)}${b.is_builtin ? " · 内置" : ""}`}
                  placement="bottom"
                >
                  <div className="an-rc-sub an-truncate">
                    @{b.username}
                    {" · "}
                    {botScopeLabel(b.scope)}
                    {b.is_builtin ? " · 内置" : ""}
                  </div>
                </Tooltip>
              </div>
              <BotOnlineBadge bot={b} />
              <AppIcon name="chevronRight" className="an-rc-chev" />
            </button>
          ))
        )}
      </div>
    </div>
  );
}

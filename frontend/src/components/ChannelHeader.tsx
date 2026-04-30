import { useEffect, useRef, useState } from "react";
import {
  Bars3Icon,
  BriefcaseIcon,
  CheckCircleIcon,
  ChatBubbleLeftEllipsisIcon,
  ClipboardDocumentListIcon,
  Cog6ToothIcon,
  DocumentTextIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import type { Channel, DM } from "../types";

export type TopicSummary = {
  rootId: string;
  title: string;
  count: number;
  lastTime?: string;
};

export type MemoryTab = "PROJECT" | "FILES_INDEX" | "MEMBERS" | "TODO";

export const MEMORY_TABS: {
  id: MemoryTab;
  label: string;
  icon: JSX.Element;
}[] = [
  {
    id: "PROJECT",
    label: "Project",
    icon: (
      <BriefcaseIcon />
    ),
  },
  {
    id: "FILES_INDEX",
    label: "Files",
    icon: (
      <DocumentTextIcon />
    ),
  },
  {
    id: "MEMBERS",
    label: "Members",
    icon: (
      <UsersIcon />
    ),
  },
  {
    id: "TODO",
    label: "Todos",
    icon: (
      <CheckCircleIcon />
    ),
  },
];

interface ChannelHeaderProps {
  channel: Channel | undefined | null;
  /** When the active channel is a DM, this carries the counterparty info so
   *  the header can render "@display_name" instead of the raw dm:uuid:uuid. */
  activeDm?: DM | null;
  isMobile: boolean;
  onOpenSidebar: () => void;

  autoAssist: boolean;
  onOpenChannelSettings: () => void;

  memoryTab: MemoryTab | null;
  onSetMemoryTab: (tab: MemoryTab | null) => void;

  topics?: TopicSummary[];
  /** Scroll the main stream to the given message id — fallback used when
   *  no onOpenTopic handler is wired. */
  onJumpToMessage?: (msgId: string) => void;
  /** When provided, the topics popover opens the given topic root as a
   *  full-page TopicPage (replacing the channel stream) instead of
   *  scrolling the main stream. */
  onOpenTopic?: (rootMsgId: string) => void;
  taskCount?: number;
  taskActive?: boolean;
  onOpenTasks?: () => void;
}

export function ChannelHeader({
  channel,
  activeDm,
  isMobile,
  onOpenSidebar,
  autoAssist,
  onOpenChannelSettings,
  memoryTab,
  onSetMemoryTab,
  topics = [],
  onJumpToMessage,
  onOpenTopic,
  taskCount = 0,
  taskActive = false,
  onOpenTasks,
}: ChannelHeaderProps) {
  const subtitle = autoAssist ? "自动接管已开启" : "";
  const [topicsOpen, setTopicsOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!topicsOpen) return;
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setTopicsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [topicsOpen]);

  return (
    <div className="an-head" style={{ paddingLeft: isMobile ? 12 : undefined }}>
      {isMobile && (
        <button
          type="button"
          onClick={onOpenSidebar}
          className="w-8 h-8 flex items-center justify-center rounded-md flex-shrink-0 hover:bg-[var(--surface-soft)] transition-colors"
          style={{ color: "var(--fg-2)" }}
        >
          <Bars3Icon className="w-6 h-6" />
        </button>
      )}

      {/* Title block */}
      <div className="min-w-0 flex-1 flex items-baseline gap-3">
        <h1 className="an-title truncate">
          {activeDm ? (
            <>
              <span className="an-hash">
                {activeDm.counterparty.member_type === "bot"
                  ? "⦿"
                  : activeDm.counterparty.member_type === "system"
                    ? "◎"
                    : "@"}
              </span>
              <span>
                {activeDm.counterparty.display_name ||
                  activeDm.counterparty.username ||
                  "DM"}
              </span>
            </>
          ) : (
            <>
              <span className="an-hash">#</span>
              <span>{channel?.name || ""}</span>
            </>
          )}
        </h1>
        {subtitle && (
          <span className="an-sub truncate hidden sm:inline">{subtitle}</span>
        )}
      </div>

      {/* Tasks + memory button group */}
      <div className="an-mem-cluster" role="group" aria-label="频道工具">
        {onOpenTasks && (
          <button
            type="button"
            className={`an-mc-btn ${taskActive ? "on" : ""}`}
            onClick={onOpenTasks}
            title="频道后台任务"
            aria-label={`频道后台任务，${taskCount} 个`}
            aria-pressed={taskActive}
          >
            <ClipboardDocumentListIcon />
            <span className="an-mc-label hidden sm:inline">Tasks</span>
            <span className="an-mc-n">{taskCount}</span>
          </button>
        )}
        {MEMORY_TABS.map((t) => {
          const on = memoryTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              className={`an-mc-btn ${on ? "on" : ""}`}
              onClick={() => onSetMemoryTab(on ? null : t.id)}
              title={`频道记忆 · ${t.label}`}
              aria-pressed={on}
            >
              {t.icon}
              <span className="an-mc-label hidden sm:inline">{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* Topics pill */}
      {!activeDm && channel && (
        <div className="relative" ref={popRef}>
          <button
            type="button"
            className={`an-topics-btn ${topicsOpen ? "on" : ""}`}
            onClick={() => setTopicsOpen((v) => !v)}
            title="频道主题"
          >
            <ChatBubbleLeftEllipsisIcon className="w-4 h-4" />
            <span className="hidden sm:inline">主题</span>
            <span className="an-tb-n">{topics.length}</span>
          </button>
          {topicsOpen && (
            <div
              className="an-topics-pop"
              style={{
                right: 0,
                top: "calc(100% + 6px)",
                position: "absolute",
              }}
            >
              <div className="an-hd">频道内的主题</div>
              {topics.length === 0 ? (
                <div className="an-menu-empty">暂无主题</div>
              ) : (
                topics.map((t) => (
                  <button
                    key={t.rootId}
                    type="button"
                    className="an-it"
                    onClick={() => {
                      setTopicsOpen(false);
                      if (onOpenTopic) onOpenTopic(t.rootId);
                      else onJumpToMessage?.(t.rootId);
                    }}
                  >
                    <div className="an-it-t">{t.title || "(无标题)"}</div>
                    <div className="an-it-s">
                      <span>{t.count} 条回复</span>
                      {t.lastTime && (
                        <>
                          <span className="an-d" />
                          <span>最近 {t.lastTime}</span>
                        </>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
      {!activeDm && channel && (
        <button
          type="button"
          onClick={onOpenChannelSettings}
          title="频道设置"
          className="w-7 h-7 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-soft)]"
          style={{ color: "var(--fg-3)" }}
        >
          <Cog6ToothIcon className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

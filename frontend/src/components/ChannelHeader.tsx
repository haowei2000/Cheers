import { useEffect, useRef, useState } from "react";
import {
  Bars3Icon,
  BriefcaseIcon,
  CheckCircleIcon,
  ChatBubbleLeftEllipsisIcon,
  ChatBubbleLeftRightIcon,
  ClipboardDocumentListIcon,
  DocumentTextIcon,
  MegaphoneIcon,
  UserIcon,
  UserPlusIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import type { Channel, CurrentUser, DM, QaPair } from "../types";
import { apiFetch } from "../api";

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
  selectedId: string | null;
  /** When the active channel is a DM, this carries the counterparty info so
   *  the header can render "@display_name" instead of the raw dm:uuid:uuid. */
  activeDm?: DM | null;
  isMobile: boolean;
  onOpenSidebar: () => void;

  autoAssist: boolean;
  setAutoAssist: (v: boolean) => void;
  authToken: string | null;
  setChannels: React.Dispatch<React.SetStateAction<Channel[]>>;

  blockPairsForExport: QaPair[];
  onOpenQaSummary: () => void;

  memoryTab: MemoryTab | null;
  onSetMemoryTab: (tab: MemoryTab | null) => void;

  onOpenManageMembers: () => void;

  currentUser: CurrentUser;
  onOpenChannelProfile: () => void;

  /** Open the announcement-composer modal. Omitted → the megaphone button
   *  doesn't render (e.g. on DM headers where announcements don't apply). */
  onOpenAnnouncementComposer?: () => void;

  topics?: TopicSummary[];
  /** Scroll the main stream to the given message id — fallback used when
   *  no onOpenTopic handler is wired. */
  onJumpToMessage?: (msgId: string) => void;
  /** When provided, the topics popover opens the given topic root as a
   *  full-page TopicPage (replacing the channel stream) instead of
   *  scrolling the main stream. */
  onOpenTopic?: (rootMsgId: string) => void;
  taskCount?: number;
  onOpenTasks?: () => void;
}

export function ChannelHeader({
  channel,
  selectedId,
  activeDm,
  isMobile,
  onOpenSidebar,
  autoAssist,
  setAutoAssist,
  authToken,
  setChannels,
  blockPairsForExport,
  onOpenQaSummary,
  memoryTab,
  onSetMemoryTab,
  onOpenManageMembers,
  currentUser,
  onOpenChannelProfile,
  onOpenAnnouncementComposer,
  topics = [],
  onJumpToMessage,
  onOpenTopic,
  taskCount = 0,
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
                {activeDm.counterparty.member_type === "bot" ? "⦿" : "@"}
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

      {/* Auto-assist toggle — h-7 reserves the same 28px row height as the
          threads pill / memory cluster / icon buttons so the header sits on
          one visual baseline. */}
      <label
        className="flex items-center gap-1.5 cursor-pointer select-none flex-shrink-0 h-7"
        title={
          autoAssist ? "自动调用内置助手（开启中）" : "自动调用内置助手（关闭）"
        }
      >
        <span
          className="text-[11px] whitespace-nowrap hidden sm:inline"
          style={{ color: "var(--fg-3)" }}
        >
          自动接管
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={autoAssist}
          onClick={() => {
            const next = !autoAssist;
            setAutoAssist(next);
            apiFetch(`/channels/${selectedId}`, {
              method: "PATCH",
              body: { auto_assist: next },
              token: authToken,
            })
              .then((r) => r.json())
              .then((d) => {
                if (d.data) {
                  setChannels((prev) =>
                    prev.map((c) =>
                      c.channel_id === selectedId
                        ? { ...c, auto_assist: d.data.auto_assist }
                        : c,
                    ),
                  );
                }
              })
              .catch(() => setAutoAssist(!next));
          }}
          className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none"
          style={{
            background: autoAssist
              ? "var(--accent)"
              : "var(--surface-strong)",
          }}
        >
          <span
            className="inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform"
            style={{
              transform: autoAssist ? "translateX(18px)" : "translateX(3px)",
            }}
          />
        </button>
      </label>

      {/* Topics pill */}
      {topics.length > 0 && (
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
              {topics.map((t) => (
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
              ))}
            </div>
          )}
        </div>
      )}

      {taskCount > 0 && onOpenTasks && (
        <button
          type="button"
          className="an-topics-btn"
          onClick={onOpenTasks}
          title="频道任务"
        >
          <ClipboardDocumentListIcon className="w-4 h-4" />
          <span className="hidden sm:inline">Tasks</span>
          <span className="an-tb-n">{taskCount}</span>
        </button>
      )}

      {/* Memory cluster — 4 memory tabs: Project / Files / Members / Todos */}
      <div className="an-mem-cluster" role="group" aria-label="频道记忆">
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

      {/* Auxiliary icon buttons — Announce / QA / Manage members / Channel profile */}
      {onOpenAnnouncementComposer && (
        <button
          type="button"
          onClick={onOpenAnnouncementComposer}
          title="发布公告"
          aria-label="发布公告"
          className="w-7 h-7 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-soft)]"
          style={{ color: "var(--fg-3)" }}
        >
          <MegaphoneIcon className="w-4 h-4" />
        </button>
      )}
      {blockPairsForExport.length > 0 && (
        <button
          type="button"
          onClick={onOpenQaSummary}
          title="生成问答总结"
          className="w-7 h-7 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-soft)]"
          style={{ color: "var(--fg-3)" }}
        >
          <ChatBubbleLeftRightIcon className="w-4 h-4" />
        </button>
      )}
      <button
        type="button"
        onClick={onOpenManageMembers}
        title="成员管理"
        className="w-7 h-7 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-soft)]"
        style={{ color: "var(--fg-3)" }}
      >
        <UserPlusIcon className="w-4 h-4" />
      </button>
      {currentUser && (
        <button
          type="button"
          onClick={onOpenChannelProfile}
          title="我的频道资料"
          className="w-7 h-7 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-soft)]"
          style={{ color: "var(--fg-3)" }}
        >
          <UserIcon className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

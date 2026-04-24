import { useEffect, useRef, useState } from "react";
import type { Channel, CurrentUser, DM, QaPair } from "../types";
import { apiFetch } from "../api";

export type ThreadSummary = {
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
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 7h18M5 7v12a1 1 0 001 1h12a1 1 0 001-1V7M9 4h6a1 1 0 011 1v2H8V5a1 1 0 011-1z" />
      </svg>
    ),
  },
  {
    id: "FILES_INDEX",
    label: "Files",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" />
        <path d="M14 3v5h5M9 13h6M9 17h4" />
      </svg>
    ),
  },
  {
    id: "MEMBERS",
    label: "Members",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="9" cy="9" r="3.2" />
        <path d="M3 19c.8-3.2 3.2-5 6-5s5.2 1.8 6 5" />
        <circle cx="17" cy="8" r="2.2" />
        <path d="M15 14.5c1.8-.5 3.6 0 5 2" />
      </svg>
    ),
  },
  {
    id: "TODO",
    label: "Todos",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 7l2 2 4-4" />
        <path d="M4 15l2 2 4-4" />
        <path d="M13 7h7M13 15h7" />
      </svg>
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

  threads?: ThreadSummary[];
  /** Scroll the main stream to the given message id (used by existing
   *  threads-popover behaviour when no panel handler is provided). */
  onJumpToMessage?: (msgId: string) => void;
  /** When provided, the threads popover opens the given thread root in the
   *  side-dock ThreadPanel instead of scrolling the main stream. */
  onOpenThread?: (rootMsgId: string) => void;
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
  threads = [],
  onJumpToMessage,
  onOpenThread,
}: ChannelHeaderProps) {
  const subtitle = autoAssist ? "自动接管已开启" : "";
  const [threadsOpen, setThreadsOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!threadsOpen) return;
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setThreadsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [threadsOpen]);

  return (
    <div className="an-head" style={{ paddingLeft: isMobile ? 12 : undefined }}>
      {isMobile && (
        <button
          type="button"
          onClick={onOpenSidebar}
          className="w-8 h-8 flex items-center justify-center rounded-md flex-shrink-0 hover:bg-[var(--surface-soft)] transition-colors"
          style={{ color: "var(--fg-2)" }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="w-6 h-6"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
            />
          </svg>
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

      {/* Auto-assist toggle */}
      <label
        className="flex items-center gap-1.5 cursor-pointer select-none flex-shrink-0"
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

      {/* Threads pill */}
      {threads.length > 0 && (
        <div className="relative" ref={popRef}>
          <button
            type="button"
            className={`an-threads-btn ${threadsOpen ? "on" : ""}`}
            onClick={() => setThreadsOpen((v) => !v)}
            title="频道对话串"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M2 3h12M2 7h9M2 11h6" strokeLinecap="round" />
              <circle cx="13" cy="11" r="2.3" />
            </svg>
            <span className="hidden sm:inline">对话串</span>
            <span className="an-tb-n">{threads.length}</span>
          </button>
          {threadsOpen && (
            <div
              className="an-threads-pop"
              style={{
                right: 0,
                top: "calc(100% + 6px)",
                position: "absolute",
              }}
            >
              <div className="an-hd">频道内的对话串</div>
              {threads.map((t) => (
                <button
                  key={t.rootId}
                  type="button"
                  className="an-it"
                  onClick={() => {
                    setThreadsOpen(false);
                    if (onOpenThread) onOpenThread(t.rootId);
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
          className="w-8 h-8 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-soft)]"
          style={{ color: "var(--fg-3)" }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-4 h-4"
          >
            <path d="M3 11v2a1 1 0 0 0 1 1h1l6 5V5L5 10H4a1 1 0 0 0-1 1Z" />
            <path d="M15 8.5a4 4 0 0 1 0 7" />
            <path d="M18 6a7 7 0 0 1 0 12" />
          </svg>
        </button>
      )}
      {blockPairsForExport.length > 0 && (
        <button
          type="button"
          onClick={onOpenQaSummary}
          title="生成问答总结"
          className="w-8 h-8 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-soft)]"
          style={{ color: "var(--fg-3)" }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-4 h-4"
          >
            <path d="M8 10h8M8 14h5" />
            <path d="M21 12a9 9 0 11-3.7-7.25L21 3v5h-5" />
          </svg>
        </button>
      )}
      <button
        type="button"
        onClick={onOpenManageMembers}
        title="成员管理"
        className="w-8 h-8 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-soft)]"
        style={{ color: "var(--fg-3)" }}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4"
        >
          <circle cx="9" cy="8" r="3.2" />
          <path d="M3 19c.8-3.2 3.2-5 6-5s5.2 1.8 6 5" />
          <path d="M17 11v4M15 13h4" />
        </svg>
      </button>
      {currentUser && (
        <button
          type="button"
          onClick={onOpenChannelProfile}
          title="我的频道资料"
          className="w-8 h-8 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-soft)]"
          style={{ color: "var(--fg-3)" }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-4 h-4"
          >
            <circle cx="12" cy="8" r="3.2" />
            <path d="M5 19c1-3.6 3.8-6 7-6s6 2.4 7 6" />
          </svg>
        </button>
      )}
    </div>
  );
}

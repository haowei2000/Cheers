import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import type { Channel, Workspace, CurrentUser } from "../types";
import { apiFetch } from "../api";
import { refreshChannels, refreshWorkspaces } from "../lib/refresh";

interface SidebarProps {
  isMobile: boolean;
  sidebarOpen: boolean;
  leftWidth: number;
  onLeftResize: (e: React.MouseEvent) => void;

  currentUser: CurrentUser;
  authToken: string | null;
  onLogout: () => void;
  onLoginClick: () => void;

  workspaces: Workspace[];
  setWorkspaces: (w: Workspace[]) => void;
  selectedWorkspaceId: string;
  setSelectedWorkspaceId: (id: string) => void;

  channels: Channel[];
  setChannels: React.Dispatch<React.SetStateAction<Channel[]>>;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;

  setSidebarOpen: (open: boolean) => void;

  onOpenKeychain: () => void;
  onOpenUserProfile: () => void;
  onOpenCreateWorkspace: () => void;
  onOpenInviteWsMember: () => void;
  onOpenCreateChannel: () => void;
  onOpenQuickConnect: () => void;
  onOpenNotifications: () => void;
  onOpenFriends: () => void;
  onOpenHelp: () => void;

  isDark: boolean;
  toggleTheme: () => void;
}

export function Sidebar({
  isMobile,
  sidebarOpen,
  leftWidth,
  onLeftResize,
  currentUser,
  authToken,
  onLogout,
  onLoginClick,
  workspaces,
  setWorkspaces,
  selectedWorkspaceId,
  setSelectedWorkspaceId,
  channels,
  setChannels,
  selectedId,
  setSelectedId,
  setSidebarOpen,
  onOpenKeychain,
  onOpenUserProfile,
  onOpenCreateWorkspace,
  onOpenInviteWsMember,
  onOpenCreateChannel,
  onOpenQuickConnect,
  onOpenNotifications,
  onOpenFriends,
  onOpenHelp,
  isDark,
  toggleTheme,
}: SidebarProps) {
  return (
    <aside
      className={`bg-[#3F0E40] flex flex-col flex-shrink-0 ${isMobile ? "fixed inset-y-0 left-0 z-[60] shadow-2xl transition-transform duration-300 ease-in-out" : "relative"}`}
      style={{
        width: isMobile ? "280px" : leftWidth,
        transform:
          isMobile && !sidebarOpen ? "translateX(-100%)" : "translateX(0)",
      }}
    >
      {/* Workspace header */}
      <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-white font-bold text-lg truncate">智枢协作</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4 text-white/60 flex-shrink-0"
          >
            <path
              fillRule="evenodd"
              d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
              clipRule="evenodd"
            />
          </svg>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {currentUser ? (
            <>
              <button
                type="button"
                onClick={onOpenKeychain}
                className="w-6 h-6 flex items-center justify-center rounded text-white/40 hover:text-white hover:bg-white/10 transition-colors"
                title="密钥链"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="w-3.5 h-3.5"
                >
                  <path
                    fillRule="evenodd"
                    d="M8 7a5 5 0 1 1 3.61 4.804l-1.903 1.903A1 1 0 0 1 9 14H8v1a1 1 0 0 1-1 1H6v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-2a1 1 0 0 1 .293-.707L7.196 10.39A5.002 5.002 0 0 1 8 7Zm5-3a.75.75 0 0 0 0 1.5A1.5 1.5 0 0 1 14.5 7 .75.75 0 0 0 16 7a3 3 0 0 0-3-3Z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
              <button
                type="button"
                onClick={onOpenUserProfile}
                className="w-7 h-7 rounded-full bg-[#D0B3D3] text-[#3F0E40] text-xs font-bold flex items-center justify-center hover:bg-white transition-colors"
                title={`${currentUser.display_name} · 编辑资料`}
              >
                {currentUser.display_name.slice(0, 1).toUpperCase()}
              </button>
              <button
                type="button"
                onClick={onLogout}
                className="w-6 h-6 flex items-center justify-center rounded text-white/40 hover:text-white hover:bg-white/10 transition-colors"
                title="退出登录"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className="w-3.5 h-3.5"
                >
                  <path
                    fillRule="evenodd"
                    d="M2 4.75A2.75 2.75 0 0 1 4.75 2h3a2.75 2.75 0 0 1 2.75 2.75v.5a.75.75 0 0 1-1.5 0v-.5c0-.69-.56-1.25-1.25-1.25h-3c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h3c.69 0 1.25-.56 1.25-1.25v-.5a.75.75 0 0 1 1.5 0v.5A2.75 2.75 0 0 1 7.75 14h-3A2.75 2.75 0 0 1 2 11.25v-6.5Zm9.47.47a.75.75 0 0 1 1.06 0l2.25 2.25a.75.75 0 0 1 0 1.06l-2.25 2.25a.75.75 0 1 1-1.06-1.06l.97-.97H6.75a.75.75 0 0 1 0-1.5h5.69l-.97-.97a.75.75 0 0 1 0-1.06Z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </>
          ) : (
            <button
              onClick={onLoginClick}
              className="text-xs text-white/70 hover:text-white px-2 py-1"
            >
              登录
            </button>
          )}
        </div>
      </div>

      {/* User status bar */}
      {currentUser && (
        <div className="px-4 py-2 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
          <span className="text-[#C9BDD0] text-sm truncate">
            {currentUser.display_name}
          </span>
        </div>
      )}

      {/* Workspace selector */}
      <div className="px-3 py-2">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[#C9BDD0] text-xs font-semibold uppercase tracking-wider">
            工作空间
          </span>
          <div className="flex items-center gap-1">
            {selectedWorkspaceId && (
              <button
                type="button"
                onClick={onOpenInviteWsMember}
                className="text-white/60 hover:text-white text-xs p-1 rounded hover:bg-white/10"
                title="邀请成员"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="w-4 h-4"
                >
                  <path d="M11 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM2.046 15.253c-.058.468.172.92.57 1.174A9.953 9.953 0 0 0 8 18c1.536 0 2.991-.346 4.184-.964l-4.253-4.25A3.5 3.5 0 0 0 5.6 11.5H5.5a3.5 3.5 0 0 0-3.454 3.753ZM15.5 9.5a.75.75 0 0 0-1.5 0v1.5H12.5a.75.75 0 0 0 0 1.5H14v1.5a.75.75 0 0 0 1.5 0V12.5h1.5a.75.75 0 0 0 0-1.5H15.5V9.5Z" />
                </svg>
              </button>
            )}
            {selectedWorkspaceId && (
              <button
                type="button"
                onClick={() => {
                  if (
                    !confirm(
                      "确定删除该工作空间？删除后其下的频道也将被删除。",
                    )
                  )
                    return;
                  apiFetch(`/workspaces/${selectedWorkspaceId}`, {
                    method: "DELETE",
                    token: authToken,
                  })
                    .then((r) => r.json())
                    .then((d) => {
                      if (d.status === "success") {
                        toast.success("工作空间已删除");
                        setSelectedWorkspaceId("");
                        refreshWorkspaces(setWorkspaces, authToken);
                        refreshChannels(setChannels, authToken);
                      } else {
                        toast.error(d.detail || "删除失败");
                      }
                    })
                    .catch(() => toast.error("请求失败"));
                }}
                className="text-white/60 hover:text-red-400 text-xs p-1 rounded hover:bg-white/10"
                title="删除工作空间"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="w-4 h-4"
                >
                  <path
                    fillRule="evenodd"
                    d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            )}
            <button
              type="button"
              onClick={onOpenCreateWorkspace}
              className="text-white/60 hover:text-white text-xs p-1 rounded hover:bg-white/10"
              title="创建工作空间"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="w-4 h-4"
              >
                <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
              </svg>
            </button>
          </div>
        </div>
        <select
          value={selectedWorkspaceId}
          onChange={(e) => setSelectedWorkspaceId(e.target.value)}
          className="w-full bg-white/10 text-white text-sm rounded px-2 py-1.5 border border-white/20 focus:outline-none focus:border-white/40"
        >
          <option value="" className="text-gray-900">
            全部工作空间
          </option>
          {workspaces.map((w) => (
            <option
              key={w.workspace_id}
              value={w.workspace_id}
              className="text-gray-900"
            >
              {w.name}
            </option>
          ))}
        </select>
      </div>

      {/* Channels section */}
      <div className="px-3 pt-3 pb-1 flex items-center justify-between">
        <span className="text-[#C9BDD0] text-xs font-semibold uppercase tracking-wider">
          频道
        </span>
        <button
          type="button"
          onClick={() => {
            if (!selectedWorkspaceId) {
              toast.error("请先选择工作空间");
              return;
            }
            onOpenCreateChannel();
          }}
          className="text-white/60 hover:text-white text-xs p-1 rounded hover:bg-white/10"
          title="创建频道"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4"
          >
            <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
          </svg>
        </button>
      </div>
      <ul className="overflow-auto flex-1 px-2">
        {channels
          .filter(
            (c) => !selectedWorkspaceId || c.workspace_id === selectedWorkspaceId,
          )
          .map((c) => (
            <li
              key={c.channel_id}
              className="group relative"
              onClick={() => isMobile && setSidebarOpen(false)}
            >
              <button
                type="button"
                onClick={() => setSelectedId(c.channel_id)}
                className={`w-full text-left px-2.5 py-1.5 rounded-lg text-[13px] flex items-center gap-1.5 transition-colors pr-7 ${
                  selectedId === c.channel_id
                    ? "bg-white/20 text-white font-semibold"
                    : "text-[#C9BDD0] hover:bg-white/10 hover:text-white"
                }`}
              >
                <span className="text-current opacity-60 text-base leading-none">
                  #
                </span>
                <span className="truncate">{c.name}</span>
                {!selectedWorkspaceId &&
                  c.workspace_id &&
                  (() => {
                    const ws = workspaces.find(
                      (w) => w.workspace_id === c.workspace_id,
                    );
                    const abbrev = ws ? ws.name.slice(0, 4) : "";
                    return abbrev ? (
                      <span className="ml-1 flex-shrink-0 text-[10px] px-1 py-0 rounded bg-white/10 text-[#C9BDD0] leading-4">
                        {abbrev}
                      </span>
                    ) : null;
                  })()}
              </button>
              <button
                type="button"
                title="删除频道"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!confirm(`确定删除频道「${c.name}」？此操作不可恢复。`))
                    return;
                  apiFetch(`/channels/${c.channel_id}`, {
                    method: "DELETE",
                    token: authToken,
                  })
                    .then((r) => {
                      if (!r.ok) throw new Error("删除失败");
                      setChannels((prev) =>
                        prev.filter((x) => x.channel_id !== c.channel_id),
                      );
                      if (selectedId === c.channel_id) setSelectedId(null);
                    })
                    .catch(() => toast.error("删除频道失败"));
                }}
                className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-white/20 text-[#C9BDD0] hover:text-red-300"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className="w-3 h-3"
                >
                  <path
                    fillRule="evenodd"
                    d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5ZM6.05 6a.75.75 0 0 1 .787.713l.275 5.5a.75.75 0 0 1-1.498.075l-.275-5.5A.75.75 0 0 1 6.05 6Zm3.9 0a.75.75 0 0 1 .712.787l-.275 5.5a.75.75 0 0 1-1.498-.075l.275-5.5a.75.75 0 0 1 .786-.711Z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </li>
          ))}
      </ul>

      {/* Bottom nav */}
      <div className="px-2 py-2 border-t border-white/10 space-y-0.5">
        <button
          type="button"
          onClick={() => {
            onOpenNotifications();
            if (isMobile) setSidebarOpen(false);
          }}
          className="relative flex items-center gap-2 w-full text-left px-2 py-1.5 rounded text-[#C9BDD0] hover:bg-white/10 hover:text-white text-sm transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4"
          >
            <path d="M4.214 3.227a.75.75 0 0 0-1.156-.956 8.97 8.97 0 0 0-1.856 5.476.75.75 0 0 0 1.498.066A7.47 7.47 0 0 1 4.214 3.227ZM16.942 2.271a.75.75 0 0 0-1.157.956 7.47 7.47 0 0 1 1.514 4.586.75.75 0 0 0 1.498-.066 8.97 8.97 0 0 0-1.855-5.476ZM10 2a6 6 0 0 0-6 6v1.076a2.25 2.25 0 0 1-.659 1.59l-.537.537a1.5 1.5 0 0 0 1.06 2.563h12.272a1.5 1.5 0 0 0 1.06-2.563l-.537-.537A2.25 2.25 0 0 1 16 9.076V8a6 6 0 0 0-6-6ZM8.5 17.5a1.5 1.5 0 0 0 3 0H8.5Z" />
          </svg>
          <span>通知</span>
        </button>
        <button
          type="button"
          onClick={() => {
            onOpenFriends();
            if (isMobile) setSidebarOpen(false);
          }}
          className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded text-[#C9BDD0] hover:bg-white/10 hover:text-white text-sm transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4"
          >
            <path d="M10 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM1.49 15.326a.78.78 0 0 1-.358-.442 3 3 0 0 1 4.308-3.516 6.484 6.484 0 0 0-1.905 3.959c-.023.222-.014.442.025.654a4.97 4.97 0 0 1-2.07-.655ZM16.44 15.98a4.97 4.97 0 0 0 2.07-.654.78.78 0 0 0 .357-.442 3 3 0 0 0-4.308-3.517 6.484 6.484 0 0 1 1.907 3.96 2.32 2.32 0 0 1-.026.654ZM18 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM5.304 16.19a.844.844 0 0 1-.277-.71 5 5 0 0 1 9.947 0 .843.843 0 0 1-.277.71A6.975 6.975 0 0 1 10 18a6.974 6.974 0 0 1-4.696-1.81Z" />
          </svg>
          <span>好友</span>
        </button>
        <button
          type="button"
          onClick={() => {
            onOpenQuickConnect();
            if (isMobile) setSidebarOpen(false);
          }}
          className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded text-[#C9BDD0] hover:bg-white/10 hover:text-white text-sm transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4"
          >
            <path
              fillRule="evenodd"
              d="M11.983 1.907a.75.75 0 0 0-1.292-.657l-8.5 9.5A.75.75 0 0 0 2.75 12h6.572l-1.305 6.093a.75.75 0 0 0 1.292.657l8.5-9.5A.75.75 0 0 0 17.25 8h-6.572l1.305-6.093Z"
              clipRule="evenodd"
            />
          </svg>
          <span>接入 OpenClaw</span>
        </button>
        <Link
          to="/admin"
          onClick={() => isMobile && setSidebarOpen(false)}
          className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded text-[#C9BDD0] hover:bg-white/10 hover:text-white text-sm transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4"
          >
            <path
              fillRule="evenodd"
              d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
              clipRule="evenodd"
            />
          </svg>
          <span>管理</span>
        </Link>
        <Link
          to="/docs"
          onClick={() => isMobile && setSidebarOpen(false)}
          className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded text-[#C9BDD0] hover:bg-white/10 hover:text-white text-sm transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4"
          >
            <path
              fillRule="evenodd"
              d="M4 4a2 2 0 0 1 2-2h4.586A2 2 0 0 1 12 2.586L15.414 6A2 2 0 0 1 16 7.414V16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4Zm2 6a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H7a1 1 0 0 1-1-1Zm1 3a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2H7Z"
              clipRule="evenodd"
            />
          </svg>
          <span>Docs</span>
        </Link>
        <Link
          to="/bulletin"
          onClick={() => isMobile && setSidebarOpen(false)}
          className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded text-[#C9BDD0] hover:bg-white/10 hover:text-white text-sm transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4"
          >
            <path d="M10 2a6 6 0 0 0-6 6v3.586l-.707.707A1 1 0 0 0 4 14h12a1 1 0 0 0 .707-1.707L16 11.586V8a6 6 0 0 0-6-6ZM10 18a3 3 0 0 1-2.83-2h5.66A3 3 0 0 1 10 18Z" />
          </svg>
          <span>留言板</span>
        </Link>
        <button
          type="button"
          onClick={toggleTheme}
          className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded text-[#C9BDD0] hover:bg-white/10 hover:text-white text-sm transition-colors"
          title={isDark ? "切换到浅色模式" : "切换到深色模式"}
        >
          {isDark ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="w-4 h-4"
            >
              <path d="M10 2a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 2ZM10 15a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 15ZM10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM15.657 5.404a.75.75 0 1 0-1.06-1.06l-1.061 1.06a.75.75 0 0 0 1.06 1.06l1.06-1.06ZM6.464 14.596a.75.75 0 1 0-1.06-1.06l-1.06 1.06a.75.75 0 0 0 1.06 1.06l1.06-1.06ZM18 10a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 18 10ZM5 10a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 5 10ZM14.596 13.536a.75.75 0 0 1 1.06 0l1.06 1.06a.75.75 0 0 1-1.06 1.06l-1.06-1.06a.75.75 0 0 1 0-1.06ZM5.404 5.404a.75.75 0 0 1 0-1.06l1.06-1.06a.75.75 0 1 1 1.06 1.06l-1.06 1.06a.75.75 0 0 1-1.06 0Z" />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="w-4 h-4"
            >
              <path
                fillRule="evenodd"
                d="M7.455 2.004a.75.75 0 0 1 .26.77 7 7 0 0 0 9.958 7.967.75.75 0 0 1 1.067.853A8.5 8.5 0 1 1 6.647 1.921a.75.75 0 0 1 .808.083Z"
                clipRule="evenodd"
              />
            </svg>
          )}
          <span>{isDark ? "浅色模式" : "深色模式"}</span>
        </button>
        <button
          type="button"
          onClick={() => {
            onOpenHelp();
            if (isMobile) setSidebarOpen(false);
          }}
          className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded text-[#C9BDD0] hover:bg-white/10 hover:text-white text-sm transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4"
          >
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 10a1 1 0 0 1 1-1 1 1 0 1 1 0 2 1 1 0 0 1-1-1Z"
              clipRule="evenodd"
            />
          </svg>
          <span>帮助</span>
        </button>
      </div>

      {/* Left sidebar resize handle */}
      {!isMobile && (
        <div
          onMouseDown={onLeftResize}
          className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-white/30 transition-colors z-10"
        />
      )}
    </aside>
  );
}

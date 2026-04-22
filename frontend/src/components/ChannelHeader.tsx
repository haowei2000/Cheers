import type { Channel, CurrentUser, QaPair } from "../types";
import { apiFetch } from "../api";

interface ChannelHeaderProps {
  channel: Channel | undefined | null;
  selectedId: string | null;
  isMobile: boolean;
  onOpenSidebar: () => void;

  autoAssist: boolean;
  setAutoAssist: (v: boolean) => void;
  authToken: string | null;
  setChannels: React.Dispatch<React.SetStateAction<Channel[]>>;

  blockPairsForExport: QaPair[];
  onOpenQaSummary: () => void;

  memoryPanelOpen: boolean;
  onToggleMemoryPanel: () => void;

  onOpenManageMembers: () => void;

  currentUser: CurrentUser;
  onOpenChannelProfile: () => void;
}

export function ChannelHeader({
  channel,
  selectedId,
  isMobile,
  onOpenSidebar,
  autoAssist,
  setAutoAssist,
  authToken,
  setChannels,
  blockPairsForExport,
  onOpenQaSummary,
  memoryPanelOpen,
  onToggleMemoryPanel,
  onOpenManageMembers,
  currentUser,
  onOpenChannelProfile,
}: ChannelHeaderProps) {
  return (
    <div className="px-3 sm:px-5 py-2.5 sm:py-3 border-b border-gray-100 bg-white flex items-center gap-2 sm:gap-3">
      {isMobile && (
        <button
          type="button"
          onClick={onOpenSidebar}
          className="w-8 h-8 flex items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 flex-shrink-0"
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
      <span className="text-gray-400 font-medium text-base select-none">#</span>
      <h1 className="font-semibold text-gray-900 text-base truncate flex-1">
        {channel?.name || ""}
      </h1>
      {/* Auto-assist toggle */}
      <label
        className="flex items-center gap-1.5 cursor-pointer select-none"
        title={
          autoAssist
            ? "自动调用内置助手（开启中）"
            : "自动调用内置助手（关闭）"
        }
      >
        <span className="text-xs text-gray-500 whitespace-nowrap hidden sm:inline">
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
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${autoAssist ? "bg-[#1264A3]" : "bg-gray-200"}`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${autoAssist ? "translate-x-[18px]" : "translate-x-[3px]"}`}
          />
        </button>
      </label>
      {blockPairsForExport.length > 0 && (
        <button
          type="button"
          title="生成问答总结"
          onClick={onOpenQaSummary}
          className="w-8 h-8 hidden sm:flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4"
          >
            <path
              fillRule="evenodd"
              d="M4 4a2 2 0 0 1 2-2h4.586A2 2 0 0 1 12 2.586L15.414 6A2 2 0 0 1 16 7.414V16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4Zm2 6a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5h-6.5A.75.75 0 0 1 6 10Zm.75 2.25a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5h-6.5Z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      )}
      <button
        type="button"
        onClick={onToggleMemoryPanel}
        title="频道记忆"
        className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${
          memoryPanelOpen
            ? "bg-[#1264A3] text-white"
            : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        }`}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          className="w-4 h-4"
        >
          <path d="M13 3a1 1 0 0 1 1-1 6 6 0 0 1 6 6c0 1.08-.29 2.09-.8 2.96A4 4 0 0 1 20 14a4 4 0 0 1-2.22 3.57c.14.43.22.89.22 1.43a1 1 0 1 1-2 0c0-.5-.1-.95-.27-1.37A4 4 0 0 1 14 14v-1h-1v8a1 1 0 1 1-2 0v-8h-1v1a4 4 0 0 1-1.73 3.63C8.1 18.05 8 18.5 8 19a1 1 0 1 1-2 0c0-.54.08-1 .22-1.43A4 4 0 0 1 4 14a4 4 0 0 1 .8-2.96A6 6 0 0 1 4 8a6 6 0 0 1 6-6 1 1 0 1 1 0 2 4 4 0 0 0-4 4c0 .78.22 1.5.6 2.12A4 4 0 0 1 8 14v-1H7a1 1 0 1 1 0-2h1v-1a2 2 0 1 1 4 0v1h1a1 1 0 1 1 0 2h-1v1a4 4 0 0 1 .4-1.88A4 4 0 0 0 16 8a4 4 0 0 0-3-3.87V10a1 1 0 1 1-2 0V3Z" />
        </svg>
      </button>
      <button
        type="button"
        onClick={onOpenManageMembers}
        title="成员管理"
        className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="w-4 h-4"
        >
          <path d="M10 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM1.49 15.326a.78.78 0 0 1-.358-.442 3 3 0 0 1 4.308-3.516 6.484 6.484 0 0 0-1.905 3.959c-.023.222-.014.442.025.654a4.97 4.97 0 0 1-2.07-.655ZM16.44 15.98a4.97 4.97 0 0 0 2.07-.654.78.78 0 0 0 .357-.442 3 3 0 0 0-4.308-3.517 6.484 6.484 0 0 1 1.907 3.96 2.32 2.32 0 0 1-.026.654ZM18 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM5.304 16.19a.844.844 0 0 1-.277-.71 5 5 0 0 1 9.947 0 .843.843 0 0 1-.277.71A6.975 6.975 0 0 1 10 18a6.974 6.974 0 0 1-4.696-1.81Z" />
        </svg>
      </button>
      {currentUser && (
        <button
          type="button"
          onClick={onOpenChannelProfile}
          title="我的频道资料"
          className="w-8 h-8 hidden sm:flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4"
          >
            <path d="M10 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.465 14.493a1.23 1.23 0 0 0 .41 1.412A9.957 9.957 0 0 0 10 18c2.31 0 4.438-.784 6.131-2.1.43-.333.604-.903.408-1.41a7.002 7.002 0 0 0-13.074.003Z" />
          </svg>
        </button>
      )}
    </div>
  );
}

import { useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "../api";

type QcResult = {
  bot: { bot_id: string; username: string; display_name: string };
  probe: { who_am_i: string; skills: string; connected: boolean };
};

interface OpenClawQcModalProps {
  open: boolean;
  onClose: () => void;
  channelId: string | null;
  channelName?: string;
}

export function OpenClawQcModal({ open, onClose, channelId, channelName }: OpenClawQcModalProps) {
  const [qcUrl, setQcUrl] = useState("");
  const [qcToken, setQcToken] = useState("");
  const [qcAgentId, setQcAgentId] = useState("main");
  const [qcBotName, setQcBotName] = useState("");
  const [qcDisplayName, setQcDisplayName] = useState("");
  const [qcAddToChannel, setQcAddToChannel] = useState(true);
  const [qcLoading, setQcLoading] = useState(false);
  const [qcResult, setQcResult] = useState<QcResult | null>(null);
  const [qcError, setQcError] = useState("");

  if (!open) return null;

  const handleConnect = async () => {
    setQcLoading(true);
    setQcError("");
    try {
      const res = await apiFetch("/bots/quick-connect", {
        method: "POST",
        body: {
          url: qcUrl.trim(),
          token: qcToken.trim(),
          agent_id: qcAgentId.trim() || "main",
          bot_username: qcBotName.trim() || null,
          display_name: qcDisplayName.trim() || null,
          channel_id: qcAddToChannel && channelId ? channelId : null,
        },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || "连接失败");
      setQcResult(data.data as QcResult);
      toast.success(`Bot @${(data.data as QcResult).bot.username} 已创建`);
    } catch (e) {
      setQcError((e as Error).message || "连接失败，请检查 URL 和 Token");
    } finally {
      setQcLoading(false);
    }
  };

  const handleReset = () => {
    setQcResult(null);
    setQcError("");
    setQcUrl("");
    setQcToken("");
    setQcAgentId("main");
    setQcBotName("");
    setQcDisplayName("");
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={() => {
        if (!qcLoading) onClose();
      }}
      aria-modal="true"
      role="dialog"
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-6 pt-5 pb-4 border-b border-gray-100 flex-shrink-0">
          <div className="w-9 h-9 rounded-xl bg-[#4A154B] flex items-center justify-center flex-shrink-0">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="white"
              className="w-5 h-5"
            >
              <path
                fillRule="evenodd"
                d="M11.983 1.907a.75.75 0 0 0-1.292-.657l-8.5 9.5A.75.75 0 0 0 2.75 12h6.572l-1.305 6.093a.75.75 0 0 0 1.292.657l8.5-9.5A.75.75 0 0 0 17.25 8h-6.572l1.305-6.093Z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-bold text-gray-900">接入 OpenClaw</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              输入 Gateway URL 和 Token，自动创建 Bot 并探测其能力
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!qcLoading) onClose();
            }}
            className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl leading-none flex-shrink-0"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!qcResult ? (
            /* ── 表单 ── */
            <div className="space-y-4">
              {qcError && (
                <div className="text-sm text-red-600 bg-red-50 border border-red-200 p-3 rounded-lg">
                  {qcError}
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Gateway URL <span className="text-red-500">*</span>
                </label>
                <input
                  type="url"
                  value={qcUrl}
                  onChange={(e) => setQcUrl(e.target.value)}
                  placeholder="http://host:port 或 http://host:port/v1"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#4A154B] focus:ring-1 focus:ring-[#4A154B]"
                  disabled={qcLoading}
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  若 URL 未包含 /v1，将自动补全
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Bearer Token <span className="text-red-500">*</span>
                </label>
                <input
                  type="password"
                  value={qcToken}
                  onChange={(e) => setQcToken(e.target.value)}
                  placeholder="Gateway 鉴权 Token"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#4A154B] focus:ring-1 focus:ring-[#4A154B]"
                  disabled={qcLoading}
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Agent ID（模型名）
                  </label>
                  <input
                    type="text"
                    value={qcAgentId}
                    onChange={(e) => setQcAgentId(e.target.value)}
                    placeholder="main"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#4A154B] focus:ring-1 focus:ring-[#4A154B]"
                    disabled={qcLoading}
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Bot 显示名称
                  </label>
                  <input
                    type="text"
                    value={qcDisplayName}
                    onChange={(e) => setQcDisplayName(e.target.value)}
                    placeholder={`OpenClaw ${qcAgentId || "main"}`}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#4A154B] focus:ring-1 focus:ring-[#4A154B]"
                    disabled={qcLoading}
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Bot 用户名（@ 名）
                </label>
                <input
                  type="text"
                  value={qcBotName}
                  onChange={(e) => setQcBotName(e.target.value)}
                  placeholder={`openclaw_${qcAgentId || "main"}（留空自动生成）`}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#4A154B] focus:ring-1 focus:ring-[#4A154B]"
                  disabled={qcLoading}
                />
              </div>
              {channelId && (
                <label className="flex items-center gap-2.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={qcAddToChannel}
                    onChange={(e) => setQcAddToChannel(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 accent-[#4A154B]"
                    disabled={qcLoading}
                  />
                  <span className="text-sm text-gray-700">
                    创建后自动加入当前频道
                    <span className="text-gray-400 ml-1">#{channelName}</span>
                  </span>
                </label>
              )}
            </div>
          ) : (
            /* ── 结果展示 ── */
            <div className="space-y-4">
              {/* Connection status */}
              <div
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium ${qcResult.probe.connected ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}
              >
                {qcResult.probe.connected ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className="w-4 h-4 flex-shrink-0"
                  >
                    <path
                      fillRule="evenodd"
                      d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z"
                      clipRule="evenodd"
                    />
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className="w-4 h-4 flex-shrink-0"
                  >
                    <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
                  </svg>
                )}
                {qcResult.probe.connected
                  ? `已连接 · Bot @${qcResult.bot.username} 创建成功`
                  : `Bot @${qcResult.bot.username} 已创建，但探测请求未成功响应`}
              </div>

              {/* who_am_i */}
              <div>
                <p className="text-xs font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">
                  你是谁
                </p>
                <div className="bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-[13px] text-gray-700 whitespace-pre-wrap max-h-40 overflow-y-auto leading-relaxed">
                  {qcResult.probe.who_am_i || "（无响应）"}
                </div>
              </div>

              {/* skills */}
              <div>
                <p className="text-xs font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">
                  /skill
                </p>
                <div className="bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-[13px] text-gray-700 whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed">
                  {qcResult.probe.skills || "（无响应）"}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex justify-between items-center gap-3 flex-shrink-0">
          {!qcResult ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm font-medium"
                disabled={qcLoading}
              >
                取消
              </button>
              <button
                type="button"
                disabled={!qcUrl.trim() || !qcToken.trim() || qcLoading}
                onClick={handleConnect}
                className="flex items-center gap-2 px-5 py-2 bg-[#4A154B] text-white rounded-lg text-sm font-semibold hover:bg-[#3d1040] disabled:opacity-50 transition-colors"
              >
                {qcLoading ? (
                  <>
                    <span className="inline-block w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    探测中…
                  </>
                ) : (
                  <>
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className="w-3.5 h-3.5"
                    >
                      <path
                        fillRule="evenodd"
                        d="M9.58 1.077a.75.75 0 0 1 .43.82L9.188 6h4.062a.75.75 0 0 1 .558 1.252l-7.5 8.25a.75.75 0 0 1-1.358-.588L5.812 10H1.75a.75.75 0 0 1-.557-1.252l7.5-8.25a.75.75 0 0 1 .887-.42Z"
                        clipRule="evenodd"
                      />
                    </svg>
                    连接并探测
                  </>
                )}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={handleReset}
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm font-medium"
              >
                再接入一个
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-5 py-2 bg-[#4A154B] text-white rounded-lg text-sm font-semibold hover:bg-[#3d1040]"
              >
                完成
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

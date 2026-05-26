import { useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "../api";
import { AppIcon } from "./icons/AppIcon";
import { Modal } from "./Modal";

type QcResult = {
  bot: { bot_id: string; username: string; display_name: string };
  probe: { who_am_i: string; skills: string; connected: boolean };
};

type BotScope = "private" | "friend" | "everyone";

const BOT_SCOPE_OPTIONS: { value: BotScope; label: string; hint: string }[] = [
  { value: "private", label: "Private", hint: "Only you can start DMs or invite" },
  { value: "friend", label: "Friend", hint: "You and friends can start DMs or invite" },
  { value: "everyone", label: "Everyone", hint: "All users can start DMs or invite" },
];

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
  const [qcScope, setQcScope] = useState<BotScope>("private");
  const [qcAddToChannel, setQcAddToChannel] = useState(true);
  const [qcLoading, setQcLoading] = useState(false);
  const [qcResult, setQcResult] = useState<QcResult | null>(null);
  const [qcError, setQcError] = useState("");


  const handleConnect = async () => {
    setQcLoading(true);
    setQcError("");
    try {
      const res = await apiFetch("bots/quick-connect", {
        method: "POST",
        body: {
          url: qcUrl.trim(),
          token: qcToken.trim(),
          agent_id: qcAgentId.trim() || "main",
          bot_username: qcBotName.trim() || null,
          display_name: qcDisplayName.trim() || null,
          scope: qcScope,
          channel_id: qcAddToChannel && channelId ? channelId : null,
        },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || "Connection failed");
      setQcResult(data.data as QcResult);
      toast.success(`Bot @${(data.data as QcResult).bot.username} created`);
    } catch (e) {
      setQcError((e as Error).message || "Connection failed. Check the URL and token.");
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
    setQcScope("private");
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!qcLoading) onClose();
      }}
      maxWidth="max-w-lg"
      title={
        <span className="flex items-center gap-3">
          <span className="w-9 h-9 rounded-xl bg-[#4A154B] flex items-center justify-center flex-shrink-0">
            <AppIcon name="zap" className="w-5 h-5 text-white" />
          </span>
          <span>Connect OpenClaw (Deprecated)</span>
        </span>
      }
      description="Legacy OpenClaw quick connect. New deployments should use ACP Bridge."
    >
      <div className="max-h-[70vh] overflow-y-auto">
          {!qcResult ? (
            /* Form. */
            <div className="space-y-4">
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-5 text-amber-900">
                OpenClaw quick connect is deprecated and kept only for existing deployments.
                For new local agents, use{" "}
                <a
                  href="/acp-bridge"
                  className="font-semibold underline underline-offset-2"
                  target="_blank"
                  rel="noreferrer"
                >
                  ACP Bridge
                </a>{" "}
                and install an ACP-capable agent from npm.
              </div>
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
                  placeholder="http://host:port or http://host:port/v1"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#4A154B] focus:ring-1 focus:ring-[#4A154B]"
                  disabled={qcLoading}
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  If the URL does not include /v1, it will be completed automatically
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
                  placeholder="Gateway auth token"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#4A154B] focus:ring-1 focus:ring-[#4A154B]"
                  disabled={qcLoading}
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Agent ID (model name)
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
                    Bot display name
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
                  Bot username (@ name)
                </label>
                <input
                  type="text"
                  value={qcBotName}
                  onChange={(e) => setQcBotName(e.target.value)}
                  placeholder={`openclaw_${qcAgentId || "main"} (leave blank to auto-generate)`}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#4A154B] focus:ring-1 focus:ring-[#4A154B]"
                  disabled={qcLoading}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Scope
                </label>
                <select
                  value={qcScope}
                  onChange={(e) => setQcScope(e.target.value as BotScope)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#4A154B] focus:ring-1 focus:ring-[#4A154B]"
                  disabled={qcLoading}
                >
                  {BOT_SCOPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label} · {opt.hint}
                    </option>
                  ))}
                </select>
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
                    Automatically add to the current channel after creation
                    <span className="text-gray-400 ml-1">#{channelName}</span>
                  </span>
                </label>
              )}
            </div>
          ) : (
            /* Result display. */
            <div className="space-y-4">
              {/* Connection status */}
              <div
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium ${qcResult.probe.connected ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}
              >
                {qcResult.probe.connected ? (
                  <AppIcon name="check" className="w-4 h-4 flex-shrink-0" />
                ) : (
                  <AppIcon name="close" className="w-4 h-4 flex-shrink-0" />
                )}
                {qcResult.probe.connected
                  ? `Connected · Bot @${qcResult.bot.username} created successfully`
                  : `Bot @${qcResult.bot.username} was created, but the probe did not return a successful response`}
              </div>

              {/* who_am_i */}
              <div>
                <p className="text-xs font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">
                  Who are you
                </p>
                <div className="bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-[13px] text-gray-700 whitespace-pre-wrap max-h-40 overflow-y-auto leading-relaxed">
                  {qcResult.probe.who_am_i || "(No response)"}
                </div>
              </div>

              {/* skills */}
              <div>
                <p className="text-xs font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">
                  /skill
                </p>
                <div className="bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-[13px] text-gray-700 whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed">
                  {qcResult.probe.skills || "(No response)"}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="pt-3 mt-3 border-t border-gray-100 flex justify-between items-center gap-3">
          {!qcResult ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm font-medium"
                disabled={qcLoading}
              >
                Cancel
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
                    Probing...
                  </>
                ) : (
                  <>
                    <AppIcon name="zap" className="w-3.5 h-3.5" />
                    Connect and probe
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
                Connect another
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-5 py-2 bg-[#4A154B] text-white rounded-lg text-sm font-semibold hover:bg-[#3d1040]"
              >
                Done
              </button>
            </>
          )}
        </div>
    </Modal>
  );
}

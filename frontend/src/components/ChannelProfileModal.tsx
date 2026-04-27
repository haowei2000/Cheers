import { useState, useEffect } from "react";
import toast from "react-hot-toast";
import { Modal, ModalFooter } from "./Modal";

const API = "/api/v1";

// ── Channel Profile Modal ─────────────────────────────────────────────────────
export function ChannelProfileModal({
  open,
  channelId,
  channelName,
  userToken,
  onClose,
}: {
  open: boolean;
  channelId: string;
  channelName: string;
  userToken: string;
  onClose: () => void;
}) {
  const [nickname, setNickname] = useState("");
  const [bio, setBio] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch(`${API}/channels/${channelId}/my-profile`, {
      headers: { Authorization: `Bearer ${userToken}` },
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.data) {
          setNickname(d.data.nickname || "");
          setBio(d.data.bio || "");
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open, channelId, userToken]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API}/channels/${channelId}/my-profile`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ nickname: nickname || null, bio: bio || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "保存失败");
      toast.success("频道资料已更新");
      onClose();
    } catch (e: unknown) {
      toast.error((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="我在频道的资料"
      description={`#${channelName}`}
    >
      {loading ? (
        <div className="flex items-center justify-center py-8 text-gray-400 text-sm">
          加载中…
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
            在这里设置的昵称和简介仅在本频道内显示，不影响其他频道。
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              频道昵称
            </label>
            <input
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="留空则使用全局显示名称"
              className={inputCls}
              maxLength={64}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              频道简介
            </label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="在本频道的身份介绍…"
              className={`${inputCls} resize-none`}
              rows={4}
            />
          </div>
        </div>
      )}
      <ModalFooter>
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm font-medium"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || loading}
          className="px-4 py-2 bg-[#1264A3] text-white rounded-lg text-sm font-medium hover:bg-[#0f5a94] disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

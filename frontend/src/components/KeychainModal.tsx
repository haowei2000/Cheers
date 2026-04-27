import { useState, useEffect } from "react";
import toast from "react-hot-toast";
import {
  ArrowPathIcon,
  EyeIcon,
  EyeSlashIcon,
  InformationCircleIcon,
  KeyIcon,
  TrashIcon,
} from "@heroicons/react/24/solid";
import { Modal } from "./Modal";

const API = "/api/v1";

// ── Keychain Modal ────────────────────────────────────────────────────────────
export function KeychainModal({
  open,
  userToken,
  onClose,
}: {
  open: boolean;
  userToken: string;
  onClose: () => void;
}) {
  type KeychainItem = {
    key_id: string;
    name: string;
    description?: string;
    value_masked: string;
  };
  const [items, setItems] = useState<KeychainItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const inputCls =
    "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]";

  useEffect(() => {
    fetch(`${API}/keychain/`, {
      headers: { Authorization: `Bearer ${userToken}` },
    })
      .then((r) => r.json())
      .then(setItems)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [userToken]);

  const handleCreate = async () => {
    if (!newName.trim() || !newValue.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`${API}/keychain/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          name: newName.trim(),
          value: newValue,
          description: newDesc.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "创建失败");
      setItems((prev) => [...prev, data]);
      setNewName("");
      setNewValue("");
      setNewDesc("");
      setShowValue(false);
      toast.success("密钥已保存");
    } catch (e: any) {
      toast.error(e.message || "创建失败");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (keyId: string) => {
    setDeletingId(keyId);
    try {
      const res = await fetch(`${API}/keychain/${keyId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      if (!res.ok) throw new Error("删除失败");
      setItems((prev) => prev.filter((k) => k.key_id !== keyId));
      toast.success("密钥已删除");
    } catch (e: any) {
      toast.error(e.message || "删除失败");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <KeyIcon className="w-5 h-5 text-[#1264A3]" />
          密钥链
        </span>
      }
    >
      <div className="space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Usage hint */}
          <div className="flex items-start gap-2 p-3 bg-blue-50 rounded-lg text-xs text-blue-700">
            <InformationCircleIcon className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>
              在频道消息中使用{" "}
              <code className="font-mono bg-blue-100 px-1 rounded">
                $secret&#123;密钥名称&#125;
              </code>{" "}
              引用密钥，Bot 会自动获取真实值。
            </span>
          </div>

          {/* List */}
          {loading ? (
            <div className="text-center py-4 text-sm text-gray-400">
              加载中…
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-4 text-sm text-gray-400">
              暂无密钥，在下方添加第一个
            </div>
          ) : (
            <ul className="space-y-2">
              {items.map((item) => (
                <li
                  key={item.key_id}
                  className="flex items-center gap-3 p-3 rounded-lg bg-gray-50 border border-gray-200"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-medium text-gray-800 truncate">
                        {item.name}
                      </span>
                      <span className="font-mono text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded flex-shrink-0">
                        {item.value_masked}
                      </span>
                    </div>
                    {item.description && (
                      <p className="text-xs text-gray-400 mt-0.5 truncate">
                        {item.description}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDelete(item.key_id)}
                    disabled={deletingId === item.key_id}
                    className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40"
                    title="删除密钥"
                  >
                    {deletingId === item.key_id ? (
                      <ArrowPathIcon className="animate-spin w-3.5 h-3.5" />
                    ) : (
                      <TrashIcon className="w-3.5 h-3.5" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Add new */}
          <div className="border-t border-gray-100 pt-4 space-y-2">
            <p className="text-xs font-medium text-gray-600">添加新密钥</p>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="密钥名称（如 openai-key）"
              className={inputCls}
            />
            <div className="relative">
              <input
                type={showValue ? "text" : "password"}
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="密钥值"
                className={`${inputCls} pr-10`}
              />
              <button
                type="button"
                onClick={() => setShowValue((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                tabIndex={-1}
              >
                {showValue ? (
                  <EyeSlashIcon className="w-4 h-4" />
                ) : (
                  <EyeIcon className="w-4 h-4" />
                )}
              </button>
            </div>
            <input
              type="text"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="描述（可选）"
              className={inputCls}
            />
            <button
              type="button"
              onClick={handleCreate}
              disabled={saving || !newName.trim() || !newValue.trim()}
              className="w-full py-2 bg-[#1264A3] text-white rounded-lg text-sm font-medium hover:bg-[#0f5a94] disabled:opacity-50 transition-colors"
            >
              {saving ? "保存中…" : "保存密钥"}
            </button>
          </div>
        </div>

        <div className="flex justify-end pt-3 mt-3 border-t border-gray-100">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm font-medium"
          >
            关闭
          </button>
        </div>
    </Modal>
  );
}

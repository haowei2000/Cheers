import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import type { Workspace } from "../types";
import { apiFetch } from "../api";
import { AVATAR_ACCEPT, uploadAvatarImage } from "../lib/avatar";
import { AvatarIconPicker } from "./AvatarIconPicker";
import { AvatarVisual } from "./AvatarVisual";
import { Modal, ModalFooter } from "./Modal";

const inputCls =
  "w-full px-3 py-2 border border-[var(--border)] rounded-lg text-sm bg-[var(--bg-0)] text-[var(--fg-1)] focus:outline-none focus:border-[var(--accent)]";

function WorkspaceAvatarPreview({
  name,
  avatarUrl,
}: {
  name: string;
  avatarUrl?: string | null;
}) {
  const initials = [...(name.trim() || "?")].slice(0, 4).join("").toUpperCase();
  return (
    <AvatarVisual
      avatarUrl={avatarUrl}
      fallback={initials}
      label={name}
      radius={10}
      size={52}
      style={{
        border: avatarUrl ? "1px solid var(--border)" : undefined,
      }}
    />
  );
}

export function WorkspaceSettingsModal({
  open,
  workspace,
  authToken,
  onClose,
  onSaved,
}: {
  open: boolean;
  workspace: Workspace | null;
  authToken: string | null;
  onClose: () => void;
  onSaved: (workspace: Workspace) => void;
}) {
  const [name, setName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!workspace) return;
    setName(workspace.name || "");
    setAvatarUrl(workspace.avatar_url || "");
  }, [workspace?.workspace_id, workspace?.name, workspace?.avatar_url]);

  const saveWorkspace = async () => {
    if (!workspace) return;
    const nextName = name.trim();
    if (!nextName) {
      toast.error("请填写工作空间名称");
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch(`/workspaces/${workspace.workspace_id}`, {
        method: "PUT",
        token: authToken,
        body: {
          name: nextName,
          avatar_url: avatarUrl.trim() || null,
        },
      });
      const data = await res.json();
      if (!res.ok || data?.status === "error") {
        throw new Error(data?.message || data?.detail || "保存失败");
      }
      const saved = (data?.data || data) as Workspace;
      onSaved(saved);
      toast.success("工作空间已更新");
      onClose();
    } catch (e: unknown) {
      toast.error((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const uploadWorkspaceAvatar = async (file: File | null | undefined) => {
    if (!workspace || !file) return;
    setAvatarUploading(true);
    try {
      const uploaded = await uploadAvatarImage(
        `/avatars/workspaces/${workspace.workspace_id}`,
        file,
        authToken,
      );
      setAvatarUrl(uploaded.avatar_url);
      onSaved({ ...workspace, avatar_url: uploaded.avatar_url });
      toast.success("工作空间头像已上传");
    } catch (e: unknown) {
      toast.error((e as Error).message || "头像上传失败");
    } finally {
      setAvatarUploading(false);
      if (avatarInputRef.current) avatarInputRef.current.value = "";
    }
  };

  return (
    <Modal
      open={open && !!workspace}
      onClose={onClose}
      title="工作空间设置"
      description="名称和图标。"
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <WorkspaceAvatarPreview name={name || workspace?.name || ""} avatarUrl={avatarUrl} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold truncate" style={{ color: "var(--fg-1)" }}>
              {name || workspace?.name}
            </div>
            <div className="text-xs truncate" style={{ color: "var(--fg-3)" }}>
              {workspace?.workspace_id}
            </div>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1" style={{ color: "var(--fg-2)" }}>
            名称
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputCls}
            onKeyDown={(e) => e.key === "Enter" && saveWorkspace()}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1" style={{ color: "var(--fg-2)" }}>
            图标
          </label>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={avatarUrl}
                onChange={(e) => setAvatarUrl(e.target.value)}
                placeholder="图标 URL 或选择内置图标"
                className={inputCls}
              />
              <input
                ref={avatarInputRef}
                type="file"
                accept={AVATAR_ACCEPT}
                onChange={(e) => uploadWorkspaceAvatar(e.target.files?.[0])}
                style={{ display: "none" }}
              />
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                disabled={avatarUploading}
                className="an-btn an-btn-ghost"
                style={{ whiteSpace: "nowrap" }}
              >
                {avatarUploading ? "上传中…" : "上传"}
              </button>
            </div>
            <AvatarIconPicker
              group="workspace"
              onChange={setAvatarUrl}
              value={avatarUrl}
            />
          </div>
          {avatarUrl && (
            <button
              type="button"
              onClick={() => setAvatarUrl("")}
              className="an-btn an-btn-ghost mt-2"
            >
              清除图标
            </button>
          )}
        </div>

        <ModalFooter>
          <button type="button" onClick={onClose} className="an-btn an-btn-ghost">
            取消
          </button>
          <button
            type="button"
            onClick={saveWorkspace}
            disabled={saving}
            className="an-btn an-btn-primary"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </ModalFooter>
      </div>
    </Modal>
  );
}

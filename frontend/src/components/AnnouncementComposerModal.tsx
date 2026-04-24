/* AnnouncementComposerModal — compose and publish an announcement message.
 *
 * Submits via the existing POST /api/v1/channels/{cid}/messages endpoint
 * with msg_type="announcement" and content_data={title, pinned_by}. WS
 * fan-out delivers the new pinned banner back into the channel stream. */
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";

export interface AnnouncementComposerModalProps {
  open: boolean;
  channelId: string | null;
  channelName?: string;
  currentUserId: string;
  authToken: string | null;
  onClose: () => void;
  /** Called on successful publish. Useful for the caller to toast / refresh. */
  onPublished?: () => void;
}

export function AnnouncementComposerModal({
  open,
  channelId,
  channelName,
  currentUserId,
  authToken,
  onClose,
  onPublished,
}: AnnouncementComposerModalProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setTitle("");
      setBody("");
      setError(null);
      setBusy(false);
      // Focus the title input after the modal mounts.
      setTimeout(() => titleRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async () => {
    if (!channelId || !body.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch(`/channels/${channelId}/messages`, {
        method: "POST",
        token: authToken ?? undefined,
        body: {
          content: body.trim(),
          sender_id: currentUserId,
          sender_type: "user",
          msg_type: "announcement",
          content_data: {
            title: title.trim() || null,
            pinned_by: currentUserId,
          },
        },
      });
      if (!r.ok) throw new Error("publish failed");
      onPublished?.();
      onClose();
    } catch {
      setError("发布失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="an-modal-overlay" onClick={onClose}>
      <div
        className="an-modal"
        style={{ width: "min(560px, 100%)" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="发布公告"
      >
        <div className="an-modal-head">
          <div className="an-modal-title">
            发布公告
            {channelName && (
              <span
                style={{
                  marginLeft: 8,
                  fontWeight: 400,
                  color: "var(--fg-3)",
                  fontSize: 12,
                }}
              >
                · #{channelName}
              </span>
            )}
          </div>
          <button
            type="button"
            className="an-modal-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <div style={{ padding: "16px 20px" }}>
          <div className="an-field" style={{ marginBottom: 12 }}>
            <label className="an-label" htmlFor="an-announce-title">
              标题（可选）
            </label>
            <input
              id="an-announce-title"
              ref={titleRef}
              className="an-input"
              placeholder="例如：本周五 14:00 UTC 发布窗口"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
              maxLength={120}
            />
          </div>
          <div className="an-field">
            <label className="an-label" htmlFor="an-announce-body">
              正文
            </label>
            <textarea
              id="an-announce-body"
              className="an-textarea"
              rows={6}
              placeholder="公告内容，Markdown 可用…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <div className="an-help">
              ⌘/Ctrl + Enter 直接发布
            </div>
          </div>
          {error && (
            <div
              style={{
                marginTop: 10,
                fontSize: 12,
                color: "var(--red)",
              }}
            >
              {error}
            </div>
          )}
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            padding: "12px 20px",
            borderTop: "1px solid var(--border)",
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            className="an-btn an-btn-ghost"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button
            type="button"
            className="an-btn an-btn-primary"
            onClick={submit}
            disabled={!body.trim() || !channelId || busy}
          >
            {busy ? "发布中…" : "发布公告"}
          </button>
        </div>
      </div>
    </div>
  );
}

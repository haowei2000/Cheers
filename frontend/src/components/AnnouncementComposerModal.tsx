/* AnnouncementComposerModal — compose and publish an announcement message.
 *
 * Submits via the existing POST /api/v1/channels/{cid}/messages endpoint
 * with msg_type="announcement" and content_data={title, pinned_by}. WS
 * fan-out delivers the new pinned banner back into the channel stream. */
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";
import { Modal, ModalFooter } from "./Modal";

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
      setError("Post failed. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Post announcement"
      description={channelName ? `#${channelName}` : undefined}
      maxWidth="max-w-lg"
    >
      <div className="an-field" style={{ marginBottom: 12 }}>
        <label className="an-label" htmlFor="an-announce-title">
          Title (optional)
        </label>
        <input
          id="an-announce-title"
          ref={titleRef}
          className="an-input"
          placeholder="Example: Friday 14:00 UTC release window"
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
          Body
        </label>
        <textarea
          id="an-announce-body"
          className="an-textarea"
          rows={6}
          placeholder="Announcement content, Markdown supported..."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="an-help">⌘/Ctrl + Enter post directly</div>
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
      <ModalFooter>
        <button
          type="button"
          className="an-btn an-btn-ghost"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="an-btn an-btn-primary"
          onClick={submit}
          disabled={!body.trim() || !channelId || busy}
        >
          {busy ? "Posting..." : "Post announcement"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

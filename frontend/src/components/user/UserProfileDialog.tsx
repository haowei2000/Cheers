import { useState } from "react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { Clock } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  sendFriendRequest,
  removeFriend,
  cancelFriendRequest,
  acceptFriendRequest,
  blockUser,
} from "@/api/friends";
import { createDm } from "@/api/channels";
import { useChatStore } from "@/stores/chatStore";

export interface UserProfileData {
  user_id: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
  bio?: string | null;
  is_bot?: boolean;
  relationship_status?: "friend" | "pending_incoming" | "pending_outgoing" | "none";
  friendship_id?: string | null;
}

interface UserProfileDialogProps {
  user: UserProfileData | null;
  onClose: () => void;
  onRelationshipChanged?: () => void;
}

export function UserProfileDialog({
  user,
  onClose,
  onRelationshipChanged,
}: UserProfileDialogProps) {
  const navigate = useNavigate();
  const selectChannel = useChatStore((s) => s.selectChannel);

  const [message, setMessage] = useState("");
  const [showNoteInput, setShowNoteInput] = useState(false);
  const [busy, setBusy] = useState(false);
  const [currentStatus, setCurrentStatus] = useState<
    "friend" | "pending_incoming" | "pending_outgoing" | "none" | undefined
  >(user?.relationship_status);

  if (!user) return null;

  const status = currentStatus ?? user.relationship_status ?? "none";
  const name = user.display_name || user.username;

  async function handleStartChat() {
    if (!user) return;
    setBusy(true);
    try {
      const dm = await createDm({ target_user_id: user.user_id });
      selectChannel(dm.channel_id);
      onClose();
      navigate("/chat");
    } catch {
      toast.error("Failed to start chat");
    } finally {
      setBusy(false);
    }
  }

  async function handleSendRequest() {
    if (!user) return;
    setBusy(true);
    try {
      const res = await sendFriendRequest(user.user_id, message.trim() || undefined);
      if (res.status === "accepted") {
        setCurrentStatus("friend");
        toast.success(`You and ${name} are now friends!`);
        if (res.channel_id) {
          selectChannel(res.channel_id);
        }
      } else {
        setCurrentStatus("pending_outgoing");
        toast.success("Friend request sent");
      }
      setShowNoteInput(false);
      onRelationshipChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to send request");
    } finally {
      setBusy(false);
    }
  }

  async function handleAccept() {
    if (!user) return;
    setBusy(true);
    try {
      const res = await acceptFriendRequest(user.user_id);
      setCurrentStatus("friend");
      toast.success("Friend request accepted");
      if (res.channel_id) {
        selectChannel(res.channel_id);
      }
      onRelationshipChanged?.();
    } catch {
      toast.error("Failed to accept");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelOrDecline() {
    if (!user) return;
    setBusy(true);
    try {
      if (user.friendship_id) {
        await cancelFriendRequest(user.friendship_id);
      }
      setCurrentStatus("none");
      toast.success("Request updated");
      onRelationshipChanged?.();
    } catch {
      toast.error("Failed to cancel request");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    if (!user) return;
    if (!confirm(`Remove ${name} from your friends?`)) return;
    setBusy(true);
    try {
      await removeFriend(user.user_id);
      setCurrentStatus("none");
      toast.success(`Removed ${name}`);
      onRelationshipChanged?.();
    } catch {
      toast.error("Failed to remove friend");
    } finally {
      setBusy(false);
    }
  }

  async function handleBlock() {
    if (!user) return;
    if (!confirm(`Block ${name}? This will also remove the friendship.`)) return;
    setBusy(true);
    try {
      await blockUser(user.user_id);
      setCurrentStatus("none");
      toast.success(`Blocked ${name}`);
      onRelationshipChanged?.();
      onClose();
    } catch {
      toast.error("Failed to block user");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="User Profile" onClose={onClose} maxWidth="max-w-md">
      <div className="space-y-4">
        {/* Header with Avatar & Names */}
        <div className="flex items-start gap-4">
          <Avatar
            name={name}
            src={user.avatar_url}
            id={user.user_id}
            size="large"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate font-sans text-regular font-bold text-content-strong">
                {name}
              </h2>
              {user.is_bot && (
                <Badge tone="neutral">
                  Bot
                </Badge>
              )}
              {status === "friend" && (
                <Badge tone="accent">
                  Friend
                </Badge>
              )}
            </div>
            <p className="truncate text-compact text-content-muted">@{user.username}</p>
            <p className="mt-1 font-code text-minimal text-content-muted select-all">
              {user.user_id}
            </p>
          </div>
        </div>

        {/* Bio */}
        {user.bio ? (
          <div className="rounded bg-surface-raised p-3 text-compact text-content-secondary leading-reading">
            {user.bio}
          </div>
        ) : (
          <p className="text-compact italic text-content-muted">No bio provided</p>
        )}

        {/* Note input when adding friend */}
        {showNoteInput && status === "none" && (
          <div className="space-y-2 rounded bg-surface-raised p-3">
            <label className="block text-minimal font-medium text-content-primary">
              Verification Message (Optional)
            </label>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Hi, I'd like to add you as a friend..."
              rows={2}
              maxLength={300}
              className="resize-none text-compact"
            />
            <div className="flex justify-end gap-2 pt-1">
              <Button
                action="cancel"
                variant="ghost"
                controlSize="compact"
                onClick={() => setShowNoteInput(false)}
                disabled={busy}
              />
              <Button
                action="send"
                variant="primary"
                controlSize="compact"
                onClick={handleSendRequest}
                loading={busy}
              />
            </div>
          </div>
        )}

        {/* Actions Bar */}
        <div className="flex flex-wrap items-center gap-2 pt-2">
          {status === "friend" && (
            <>
              <Button
                action="open"
                variant="primary"
                controlSize="regular"
                onClick={handleStartChat}
                loading={busy}
                controlWidth="fill"
                className="flex-1"
              />
              <Button
                action="remove"
                variant="danger"
                controlSize="regular"
                onClick={handleRemove}
                disabled={busy}
              />
            </>
          )}

          {status === "pending_incoming" && (
            <>
              <Button
                action="accept"
                variant="primary"
                controlSize="regular"
                onClick={handleAccept}
                loading={busy}
                controlWidth="fill"
                className="flex-1"
              />
              <Button
                action="decline"
                variant="danger"
                controlSize="regular"
                onClick={handleCancelOrDecline}
                disabled={busy}
              />
            </>
          )}

          {status === "pending_outgoing" && (
            <div className="flex w-full items-center justify-between gap-2">
              <span className="flex items-center gap-1 text-compact text-content-muted">
                <Clock className="h-4 w-4" />
                Request Pending
              </span>
              <Button
                action="cancel"
                variant="danger"
                controlSize="compact"
                onClick={handleCancelOrDecline}
                disabled={busy}
              />
            </div>
          )}

          {status === "none" && !showNoteInput && (
            <Button
              action="add"
              variant="primary"
              controlSize="regular"
              controlWidth="fill"
              onClick={() => setShowNoteInput(true)}
              disabled={busy}
            />
          )}

          <Button
            action="disable"
            variant="ghost"
            controlSize="regular"
            onClick={handleBlock}
            disabled={busy}
            title="Block User"
            className="text-danger-400 hover:text-danger-300"
          />
        </div>
      </div>
    </Dialog>
  );
}

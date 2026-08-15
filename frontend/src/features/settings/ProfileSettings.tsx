import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import toast from "react-hot-toast";
import { getMe, updateMe } from "@/api/users";
import { uploadUserAvatar } from "@/api/avatars";
import { ActionButton } from "@/components/ui/action-button";
import { AvatarUpload } from "@/components/ui/AvatarUpload";
import { Field, SectionHead } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { InlineEditActions } from "@/components/ui/inline-edit-actions";
import { Input } from "@/components/ui/input";
import { ItemList, OperationsItem } from "@/components/ui/item";
import { OverflowText } from "@/components/ui/overflow-text";
import { Textarea } from "@/components/ui/textarea";
import { useAuthStore } from "@/stores/authStore";
import { queryKeys } from "@/lib/queryClient";

/** Self-service editor for display name, status line (emoji + text), and bio. */
export function ProfileEditCard() {
  const user = useAuthStore((s) => s.user);
  const setAuth = useAuthStore((s) => s.setAuth);
  const token = useAuthStore((s) => s.token);
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: queryKeys.currentUser, queryFn: getMe });
  const [displayName, setDisplayName] = useState("");
  const [statusEmoji, setStatusEmoji] = useState("");
  const [statusText, setStatusText] = useState("");
  const [bio, setBio] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [savedProfile, setSavedProfile] = useState({
    displayName: "",
    statusEmoji: "",
    statusText: "",
    bio: "",
  });

  useEffect(() => {
    const me = profile.data;
    if (!me || editing) return;
    setDisplayName(me.display_name ?? "");
    setStatusEmoji(me.status_emoji ?? "");
    setStatusText(me.status_text ?? "");
    setBio(me.bio ?? "");
    setSavedProfile({
      displayName: me.display_name ?? "",
      statusEmoji: me.status_emoji ?? "",
      statusText: me.status_text ?? "",
      bio: me.bio ?? "",
    });
    setAvatarUrl(me.avatar_url ?? null);
    if (token) {
      const currentUser = useAuthStore.getState().user;
      setAuth(
        { ...(currentUser ?? { user_id: me.user_id, display_name: null }), ...me },
        token,
      );
    }
  }, [editing, profile.data, setAuth, token]);

  const saveProfile = useMutation({
    mutationFn: updateMe,
    onSuccess: (me) => {
      queryClient.setQueryData(queryKeys.currentUser, me);
      if (token) {
        const currentUser = useAuthStore.getState().user;
        setAuth(
          { ...(currentUser ?? { user_id: me.user_id, display_name: null }), ...me },
          token,
        );
      }
    },
  });

  async function save() {
    try {
      const me = await saveProfile.mutateAsync({
        display_name: displayName.trim(),
        status_emoji: statusEmoji.trim(),
        status_text: statusText.trim(),
        bio: bio.trim(),
      });
      setSavedProfile({
        displayName: me.display_name ?? "",
        statusEmoji: me.status_emoji ?? "",
        statusText: me.status_text ?? "",
        bio: me.bio ?? "",
      });
      setEditing(false);
      toast.success("Profile saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save profile");
    }
  }

  async function handleAvatarUpload(file: File) {
    const url = await uploadUserAvatar(file);
    setAvatarUrl(url);
    queryClient.setQueryData(queryKeys.currentUser, (current: Awaited<ReturnType<typeof getMe>> | undefined) =>
      current ? { ...current, avatar_url: url } : current,
    );
    // Hydrate the store so the avatar updates everywhere it's shown.
    if (token) setAuth({ ...(user ?? { user_id: "", display_name: null }), avatar_url: url }, token);
    return url;
  }

  // Load failed: don't render the editable form. Saving an empty form over a
  // profile that never hydrated would silently wipe the user's real details.
  if (profile.isError) {
    return (
      <div className="bg-zinc-900 rounded-sm p-6">
        <p className="text-regular font-medium text-content-secondary">Couldn't load your profile</p>
        <p className="text-compact text-content-muted mt-1">
          Editing is disabled until it loads so your saved details aren't
          overwritten. Check your connection and try again.
        </p>
        <div className="mt-4">
          <ActionButton action="retry" context="settings" onClick={() => void profile.refetch()} />
        </div>
      </div>
    );
  }

  const handle = user?.username ?? user?.user_id?.slice(0, 8);

  function cancelEditing() {
    setDisplayName(savedProfile.displayName);
    setStatusEmoji(savedProfile.statusEmoji);
    setStatusText(savedProfile.statusText);
    setBio(savedProfile.bio);
    setEditing(false);
  }

  async function copyUserId() {
    if (!user?.user_id) return;
    try {
      await navigator.clipboard.writeText(user.user_id);
      setCopiedId(true);
      window.setTimeout(() => setCopiedId(false), 1500);
    } catch {
      toast.error("Clipboard unavailable — select and copy manually");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex min-w-0 items-center gap-3 border-b border-zinc-600/70 pb-4">
        <AvatarUpload
          name={displayName || user?.username}
          id={user?.user_id}
          src={avatarUrl}
          size="regular"
          onUpload={handleAvatarUpload}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-utility text-regular font-semibold text-content-primary">
            {statusEmoji && <span className="mr-1">{statusEmoji}</span>}
            {displayName || user?.username || "Unknown"}
          </p>
          <p className="truncate font-utility text-compact text-content-muted">
            @{handle}
            {statusText ? ` · ${statusText}` : ""}
          </p>
        </div>
        <InlineEditActions
          label="profile"
          editing={editing}
          saving={saveProfile.isPending}
          disabled={!profile.isSuccess}
          controlSize="regular"
          onEdit={() => setEditing(true)}
          onSave={() => void save()}
          onCancel={cancelEditing}
        />
      </div>

      {editing ? (
        <div className="space-y-4">
          <Field label="Display name" htmlFor="pf-name">
            <Input
              id="pf-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
            />
          </Field>

          <Field label="Status">
            <div className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-2 max-sm:grid-cols-1">
              <Input
                value={statusEmoji}
                onChange={(e) => setStatusEmoji(e.target.value)}
                placeholder="Emoji"
                maxLength={8}
                aria-label="Status emoji"
              />
              <Input
                value={statusText}
                onChange={(e) => setStatusText(e.target.value)}
                placeholder="What you're up to"
                maxLength={140}
                aria-label="Status text"
              />
            </div>
          </Field>

          <Field label="Bio" htmlFor="pf-bio">
            <Textarea
              id="pf-bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="A little about you"
              rows={3}
              className="resize-y"
            />
          </Field>
        </div>
      ) : bio ? (
        <p className="max-w-prose font-reading text-regular leading-reading text-content-secondary">{bio}</p>
      ) : (
        <p className="font-utility text-compact text-content-muted">No bio added.</p>
      )}

      <div>
        <SectionHead className="mb-2">Details</SectionHead>
        <ItemList presentationLevel="medium" controlSize="regular">
          <OperationsItem
            title={
              <OverflowText fullText={`User ID: ${user?.user_id ?? "—"}`} className="w-full">
                <span className="block truncate">
                  <span className="text-content-muted">User ID</span>
                  <code className="ml-3 font-utility text-compact font-normal text-content-secondary">
                    {user?.user_id ?? "—"}
                  </code>
                </span>
              </OverflowText>
            }
            actions={user?.user_id ? (
              <IconButton label="Copy user ID" controlSize="regular" onClick={() => void copyUserId()}>
                {copiedId ? <Check className="h-4 w-4 text-success-400" /> : <Copy className="h-4 w-4" />}
              </IconButton>
            ) : undefined}
          />
          <OperationsItem
            title={
              <span>
                <span className="text-content-muted">Role</span>
                <span className="ml-3 capitalize text-content-secondary">{user?.role ?? "user"}</span>
              </span>
            }
          />
        </ItemList>
      </div>
    </div>
  );
}

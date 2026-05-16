import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { apiFetch, buildWsUrl } from "../../../api";
import type { AuthFetch } from "../../../api/client";
import { API } from "../../../lib/app-config";
import { refreshChannels, refreshDMs, refreshWorkspaces } from "../../../lib/refresh";
import type { Channel, DM, Workspace } from "../../../types";

interface UseWorkspaceDirectoryOptions {
  routeWorkspaceId: string;
  routeChannelId: string | null;
  authToken: string | null;
  authFetch: AuthFetch;
  currentUserId: string;
  onCloseSettings: () => void;
}

export function useWorkspaceDirectory({
  routeWorkspaceId,
  routeChannelId,
  authToken,
  authFetch,
  currentUserId,
  onCloseSettings,
}: UseWorkspaceDirectoryOptions) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [dms, setDMs] = useState<DM[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] =
    useState<string>(routeWorkspaceId);
  const [selectedId, setSelectedId] = useState<string | null>(routeChannelId);
  const selectedIdRef = useRef<string | null>(null);

  const [createWsOpen, setCreateWsOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newWorkspaceAvatarUrl, setNewWorkspaceAvatarUrl] = useState("");
  const [inviteWsMemberOpen, setInviteWsMemberOpen] = useState(false);
  const [inviteWsIdentifier, setInviteWsIdentifier] = useState("");
  const [newChannelName, setNewChannelName] = useState("");

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    setSelectedWorkspaceId((prev) =>
      routeWorkspaceId === prev ? prev : routeWorkspaceId,
    );
    setSelectedId((prev) => (routeChannelId === prev ? prev : routeChannelId));
  }, [routeWorkspaceId, routeChannelId]);

  useEffect(() => {
    refreshChannels(setChannels, authToken ?? undefined);
    refreshDMs(setDMs, authToken ?? undefined);
    refreshWorkspaces(setWorkspaces, authToken ?? undefined);
  }, [authToken]);

  const activeWorkspace = useMemo(
    () => workspaces.find((item) => item.workspace_id === selectedWorkspaceId),
    [selectedWorkspaceId, workspaces],
  );
  const isPersonalWorkspace = activeWorkspace?.kind === "personal";

  useEffect(() => {
    if (workspaces.length === 0) return;
    const current = workspaces.find(
      (workspace) => workspace.workspace_id === selectedWorkspaceId,
    );
    if (current) return;
    const personal = workspaces.find((workspace) => workspace.kind === "personal");
    setSelectedWorkspaceId(
      personal?.workspace_id ?? workspaces[0].workspace_id,
    );
  }, [workspaces, selectedWorkspaceId]);

  const getWorkspaceIdForChannel = useCallback(
    (channelId: string): string | undefined =>
      channels.find((channel) => channel.channel_id === channelId)?.workspace_id ??
      dms.find((dm) => dm.channel_id === channelId)?.workspace_id,
    [channels, dms],
  );

  const selectedIdWorkspaceId = useMemo(() => {
    if (!selectedId) return null;
    return getWorkspaceIdForChannel(selectedId) ?? null;
  }, [getWorkspaceIdForChannel, selectedId]);

  useEffect(() => {
    if (
      selectedId &&
      selectedWorkspaceId &&
      selectedIdWorkspaceId &&
      selectedIdWorkspaceId !== selectedWorkspaceId
    ) {
      setSelectedId(null);
    }
  }, [selectedId, selectedIdWorkspaceId, selectedWorkspaceId]);

  const activeDm = useMemo(
    () => (selectedId ? dms.find((dm) => dm.channel_id === selectedId) ?? null : null),
    [dms, selectedId],
  );
  const isSystemDm = activeDm?.counterparty.member_type === "system";
  const isDmSelected = Boolean(activeDm);
  const activeBotDm =
    activeDm?.counterparty.member_type === "bot" ? activeDm : null;
  const activeDmSessionScopeId =
    activeBotDm && currentUserId
      ? activeBotDm.session_scope_id ||
        `user:${currentUserId}:bot:${activeBotDm.counterparty.member_id}`
      : null;

  const selectedChannel: Channel | null = useMemo(() => {
    const hit = channels.find((channel) => channel.channel_id === selectedId);
    if (hit) return hit;
    const dm = selectedId
      ? dms.find((item) => item.channel_id === selectedId)
      : undefined;
    if (!dm) return null;
    const label =
      dm.counterparty.display_name ||
      dm.counterparty.username ||
      "DM";
    return {
      channel_id: dm.channel_id,
      workspace_id: dm.workspace_id,
      name: label,
      type: "dm",
      auto_assist: false,
      unread_count: dm.unread_count ?? 0,
    };
  }, [channels, dms, selectedId]);

  const botMentionIdsForChannel = useCallback(
    (channelId: string): string[] => {
      const dm = dms.find((item) => item.channel_id === channelId);
      return dm?.counterparty.member_type === "bot"
        ? [dm.counterparty.member_id]
        : [];
    },
    [dms],
  );

  const resetDirectory = useCallback(() => {
    setSelectedId(null);
    setSelectedWorkspaceId("");
    setChannels([]);
    setDMs([]);
    setWorkspaces([]);
  }, []);

  const handleCreateWorkspace = useCallback(() => {
    if (!newWorkspaceName.trim()) {
      toast.error("Enter a workspace name");
      return;
    }
    authFetch(`${API}/workspaces`, {
      method: "POST",
      body: JSON.stringify({
        name: newWorkspaceName.trim(),
        avatar_url: newWorkspaceAvatarUrl.trim() || null,
      }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (data.status === "success") {
          toast.success("Workspace created");
          setNewWorkspaceName("");
          setNewWorkspaceAvatarUrl("");
          setCreateWsOpen(false);
          refreshWorkspaces(setWorkspaces, authToken ?? undefined);
          setSelectedWorkspaceId(data.data.workspace_id);
        } else {
          toast.error(data.detail || "Create failed");
        }
      })
      .catch(() => toast.error("Create failed"));
  }, [authFetch, authToken, newWorkspaceAvatarUrl, newWorkspaceName]);

  const inviteWorkspaceMember = useCallback(
    (identifier: string) => {
      const cleaned = identifier.trim();
      if (!cleaned) {
        toast.error("Enter a username");
        return;
      }
      if (!selectedWorkspaceId) {
        toast.error("Select a workspace first");
        return;
      }
      authFetch(`${API}/workspaces/${selectedWorkspaceId}/invite`, {
        method: "POST",
        body: JSON.stringify({ identifier: cleaned }),
      })
        .then((response) => response.json())
        .then((data) => {
          if (data.status === "success") {
            toast.success(data.message || "Invite sent");
            setInviteWsIdentifier("");
            setInviteWsMemberOpen(false);
          } else {
            toast.error(data.detail || "Invite failed");
          }
        })
        .catch(() => toast.error("Invite failed"));
    },
    [authFetch, selectedWorkspaceId],
  );

  const handleInviteWsMember = useCallback(() => {
    inviteWorkspaceMember(inviteWsIdentifier);
  }, [inviteWorkspaceMember, inviteWsIdentifier]);

  const handleCreateChannel = useCallback(() => {
    if (!newChannelName.trim()) {
      toast.error("Enter a channel name");
      return;
    }
    if (!selectedWorkspaceId) {
      toast.error("Select a workspace first");
      return;
    }
    authFetch(`${API}/channels`, {
      method: "POST",
      body: JSON.stringify({
        workspace_id: selectedWorkspaceId,
        name: newChannelName.trim(),
        type: "public",
        purpose: "",
      }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (data.status === "success") {
          toast.success("Channel created");
          setNewChannelName("");
          setCreateChannelOpen(false);
          refreshChannels(setChannels, authToken ?? undefined);
          setSelectedId(data.data.channel_id);
        } else {
          toast.error(data.detail || "Create failed");
        }
      })
      .catch(() => toast.error("Create failed"));
  }, [authFetch, authToken, newChannelName, selectedWorkspaceId]);

  const openDirectMessage = useCallback(
    async (memberId: string, memberType: "user" | "bot") => {
      const personal = workspaces.find((workspace) => workspace.kind === "personal");
      const workspaceId = personal?.workspace_id ?? selectedWorkspaceId;
      if (!workspaceId) {
        toast.error("Open Personal first");
        return;
      }
      try {
        const response = await apiFetch("dms", {
          method: "POST",
          token: authToken,
          body: {
            workspace_id: workspaceId,
            member_id: memberId,
            member_type: memberType,
          },
        });
        const data = await response.json();
        if (!response.ok || data?.status === "error") {
          toast.error(data?.detail || data?.message || "Failed to start DM");
          return;
        }
        const dm = data?.data as DM | undefined;
        if (!dm) return;
        setDMs((prev) =>
          prev.some((item) => item.channel_id === dm.channel_id)
            ? prev.map((item) => (item.channel_id === dm.channel_id ? dm : item))
            : [...prev, dm],
        );
        if (personal?.workspace_id) {
          setSelectedWorkspaceId(personal.workspace_id);
        }
        setSelectedId(dm.channel_id);
        onCloseSettings();
      } catch {
        toast.error("Failed to start DM");
      }
    },
    [authToken, onCloseSettings, selectedWorkspaceId, workspaces],
  );

  useEffect(() => {
    if (!currentUserId) return;
    let ws: WebSocket | null = null;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    const maxRetries = 10;
    const baseDelay = 1000;
    const maxDelay = 30000;

    const connect = () => {
      if (disposed) return;
      ws = new WebSocket(buildWsUrl(`/ws/users/${currentUserId}`));
      ws.onopen = () => {
        retryCount = 0;
      };
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "channel_new_message" && message.data) {
            const channelId = message.data.channel_id as string | undefined;
            if (!channelId || channelId === selectedId) return;
            setChannels((prev) =>
              prev.map((channel) =>
                channel.channel_id === channelId
                  ? { ...channel, unread_count: (channel.unread_count ?? 0) + 1 }
                  : channel,
              ),
            );
            setDMs((prev) =>
              prev.map((dm) =>
                dm.channel_id === channelId
                  ? { ...dm, unread_count: (dm.unread_count ?? 0) + 1 }
                  : dm,
              ),
            );
          } else if (
            message.type === "friend_request_created" ||
            message.type === "friendship_changed"
          ) {
            refreshDMs(setDMs, authToken ?? undefined);
            refreshChannels(setChannels, authToken ?? undefined);
            if (message.type === "friend_request_created") {
              toast.success("New friend requests received");
            } else if (message.type === "friendship_changed") {
              toast.success("Friend status updated");
            }
          }
        } catch {
          /* ignore malformed payloads */
        }
      };
      ws.onclose = () => {
        if (disposed || retryCount >= maxRetries) return;
        const delay = Math.min(baseDelay * 2 ** retryCount, maxDelay);
        retryCount += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => {
        // onclose handles retry.
      };
    };
    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [authToken, currentUserId, selectedId]);

  useEffect(() => {
    if (!selectedId || !authToken) return;
    setChannels((prev) =>
      prev.some(
        (channel) =>
          channel.channel_id === selectedId && (channel.unread_count ?? 0) > 0,
      )
        ? prev.map((channel) =>
            channel.channel_id === selectedId
              ? { ...channel, unread_count: 0 }
              : channel,
          )
        : prev,
    );
    setDMs((prev) =>
      prev.some(
        (dm) => dm.channel_id === selectedId && (dm.unread_count ?? 0) > 0,
      )
        ? prev.map((dm) =>
            dm.channel_id === selectedId ? { ...dm, unread_count: 0 } : dm,
          )
        : prev,
    );
    apiFetch(`/channels/${selectedId}/read`, {
      method: "POST",
      token: authToken,
    }).catch(() => {
      /* ignore; the next list refresh re-syncs unread counts */
    });
  }, [authToken, selectedId]);

  return {
    channels,
    setChannels,
    dms,
    setDMs,
    workspaces,
    setWorkspaces,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    selectedId,
    setSelectedId,
    selectedIdRef,
    selectedIdWorkspaceId,
    selectedChannel,
    isPersonalWorkspace,
    activeDm,
    isSystemDm,
    isDmSelected,
    activeBotDm,
    activeDmSessionScopeId,
    createWsOpen,
    setCreateWsOpen,
    createChannelOpen,
    setCreateChannelOpen,
    newWorkspaceName,
    setNewWorkspaceName,
    newWorkspaceAvatarUrl,
    setNewWorkspaceAvatarUrl,
    inviteWsMemberOpen,
    setInviteWsMemberOpen,
    inviteWsIdentifier,
    setInviteWsIdentifier,
    newChannelName,
    setNewChannelName,
    handleCreateWorkspace,
    inviteWorkspaceMember,
    handleInviteWsMember,
    handleCreateChannel,
    openDirectMessage,
    botMentionIdsForChannel,
    getWorkspaceIdForChannel,
    resetDirectory,
  };
}

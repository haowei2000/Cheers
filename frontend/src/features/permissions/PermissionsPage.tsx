import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Shield,
  Users,
  Sliders,
  Check,
  Globe,
  Lock,
  UserCheck,
  UserPlus,
  Radio,
  Trash2,
} from "lucide-react";
import toast from "react-hot-toast";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SurfaceSpinner } from "@/components/ui/spinner";
import { IconButton } from "@/components/ui/icon-button";
import { TabOption } from "@/components/ui/tab-option";
import { EmptyState } from "@/components/ui/empty-state";
import { RouteChromeHeader } from "@/features/desktop/RouteChromeHeader";
import {
  listBots,
  getBotSocialPolicy,
  updateBotSocialPolicy,
  type BotSocialPolicy,
} from "@/api/bots";
import {
  listApprovers,
  revokeApprover,
  type ApproverInfo,
} from "@/api/approval";
import type { BotItem } from "@/types";
import { BotPostureSection } from "@/features/bots/BotPostureSection";
import { BotPermissionGrantsSection } from "@/features/bots/BotPermissionGrantsSection";
import { cn } from "@/lib/cn";

type PermTab = "social" | "operational";

export default function PermissionsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const botIdFromQuery = searchParams.get("botId");

  const [bots, setBots] = useState<BotItem[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(botIdFromQuery);
  const [loadingBots, setLoadingBots] = useState(true);
  const [activeTab, setActiveTab] = useState<PermTab>("social");

  // Load user's bots
  useEffect(() => {
    setLoadingBots(true);
    listBots()
      .then((data) => {
        const manageable = data.filter((b) => b.can_manage);
        setBots(manageable);
        if (!selectedBotId && manageable.length > 0) {
          const first = manageable[0].bot_id;
          setSelectedBotId(first);
          setSearchParams({ botId: first });
        } else if (selectedBotId && !manageable.some((b) => b.bot_id === selectedBotId) && manageable.length > 0) {
          setSelectedBotId(manageable[0].bot_id);
        }
      })
      .catch(() => toast.error("Failed to load bots"))
      .finally(() => setLoadingBots(false));
  }, []);

  const selectBot = (id: string) => {
    setSelectedBotId(id);
    setSearchParams({ botId: id });
  };

  const selectedBot = bots.find((b) => b.bot_id === selectedBotId);

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-canvas text-content-primary">
      <RouteChromeHeader>
        <header className="mx-auto flex w-full max-w-5xl items-center gap-4 px-6 py-5 max-md:px-4">
          <IconButton
            label="Back"
            onClick={() => navigate(-1)}
            controlSize="regular"
            className="rounded-sm text-content-primary transition-colors hover:text-content-strong"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          </IconButton>
          <Shield className="h-5 w-5 text-accent-400" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <h1 className="font-serif text-regular font-bold tracking-tight text-content-strong leading-none">
              Permissions Center
            </h1>
            <p className="mt-1 hidden text-minimal text-content-muted sm:block">
              Manage social discovery and operational approvals for your bots
            </p>
          </div>
        </header>
      </RouteChromeHeader>

      <main className="mx-auto w-full max-w-5xl px-6 pb-12 max-md:px-4">
        {loadingBots ? (
          <SurfaceSpinner />
        ) : bots.length === 0 ? (
          <div className="py-16 text-center flex flex-col items-center">
            <EmptyState
              icon={Shield}
              title="No manageable bots found"
              hint="Create a bot in Fleet or contact your administrator to get management access."
            />
            <div className="mt-4">
              <Button
                action="open"
                variant="primary"
                controlSize="regular"
                onClick={() => navigate("/fleet")}
              >
                Go to Fleet
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Bot selector pills */}
            <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none" role="tablist" aria-label="Bots">
              {bots.map((b) => {
                const isSelected = b.bot_id === selectedBotId;
                return (
                  <div
                    key={b.bot_id}
                    role="button"
                    tabIndex={0}
                    onClick={() => selectBot(b.bot_id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectBot(b.bot_id);
                      }
                    }}
                    className={cn(
                      "flex items-center gap-2 px-3 py-1 rounded-md text-compact transition-colors shrink-0 cursor-pointer",
                      isSelected
                        ? "bg-zinc-800 text-content-strong font-medium shadow-sm"
                        : "bg-surface-elevated/40 text-content-primary hover:text-content-strong hover:bg-zinc-800/60"
                    )}
                  >
                    <Avatar name={b.display_name || b.username} src={b.avatar_url} size="small" />
                    <span className="truncate max-w-[140px]">{b.display_name || b.username}</span>
                    <Badge tone="neutral">Bot</Badge>
                  </div>
                );
              })}
            </div>

            {selectedBot && (
              <div className="space-y-6">
                {/* Active Bot identity strip */}
                <div className="flex items-center justify-between p-4 rounded-lg bg-surface-elevated/50">
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar
                      name={selectedBot.display_name || selectedBot.username}
                      src={selectedBot.avatar_url}
                      size="large"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h2 className="text-regular font-bold text-content-strong truncate">
                          {selectedBot.display_name || selectedBot.username}
                        </h2>
                        <span className="font-code text-minimal text-content-muted truncate">
                          @{selectedBot.username}
                        </span>
                      </div>
                      <p className="text-compact text-content-muted line-clamp-1 mt-1">
                        {selectedBot.description || "No description provided"}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      action="manage"
                      variant="ghost"
                      controlSize="compact"
                      onClick={() => navigate(`/fleet`)}
                    >
                      Fleet Settings
                    </Button>
                  </div>
                </div>

                {/* Tab switchers */}
                <div className="flex border-b border-border/40 gap-4" role="tablist" aria-label="Permissions Tabs">
                  <TabOption
                    label="Social Permissions (社交权限)"
                    leading={<Users className="h-4 w-4" />}
                    selected={activeTab === "social"}
                    onClick={() => setActiveTab("social")}
                  />
                  <TabOption
                    label="Operational Permissions (操作权限)"
                    leading={<Sliders className="h-4 w-4" />}
                    selected={activeTab === "operational"}
                    onClick={() => setActiveTab("operational")}
                  />
                </div>

                {/* Tab Panels */}
                {activeTab === "social" ? (
                  <SocialPermissionsTab botId={selectedBot.bot_id} />
                ) : (
                  <OperationalPermissionsTab botId={selectedBot.bot_id} />
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// ── Tab 1: Social Permissions ──────────────────────────────────────────────────

function SocialPermissionsTab({ botId }: { botId: string }) {
  const [policy, setPolicy] = useState<BotSocialPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [visibility, setVisibility] = useState<"public" | "friends" | "private">("public");
  const [friendPolicy, setFriendPolicy] = useState<"open" | "require_approval" | "disabled">("open");
  const [invitePolicy, setInvitePolicy] = useState<"open" | "require_approval">("require_approval");

  const load = useCallback(() => {
    setLoading(true);
    getBotSocialPolicy(botId)
      .then((p) => {
        setPolicy(p);
        setVisibility(p.visibility);
        setFriendPolicy(p.friend_policy);
        setInvitePolicy(p.invite_policy);
      })
      .catch(() => toast.error("Failed to load social policy"))
      .finally(() => setLoading(false));
  }, [botId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave() {
    setSaving(true);
    try {
      const updated = await updateBotSocialPolicy(botId, {
        visibility,
        friend_policy: friendPolicy,
        invite_policy: invitePolicy,
      });
      setPolicy(updated);
      toast.success("Social policy updated successfully");
    } catch {
      toast.error("Failed to update social policy");
    } finally {
      setSaving(false);
    }
  }

  const isDirty =
    policy &&
    (policy.visibility !== visibility ||
      policy.friend_policy !== friendPolicy ||
      policy.invite_policy !== invitePolicy);

  if (loading) return <SurfaceSpinner />;

  return (
    <div className="space-y-6">
      {/* Visibility */}
      <div className="p-5 rounded-lg bg-surface-elevated/40 space-y-4">
        <div>
          <h3 className="text-regular font-bold text-content-strong flex items-center gap-2">
            <Globe className="h-4 w-4 text-accent-400" />
            搜索与可见性 (Search Discovery)
          </h3>
          <p className="mt-1 text-compact text-content-muted">
            控制谁能在社交目录和搜索框中发现此 Bot。
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <PolicyOptionCard
            title="公开可搜 (Public)"
            desc="全网任何用户都可以通过用户名或显示名搜索并查看此 Bot。"
            selected={visibility === "public"}
            onClick={() => setVisibility("public")}
          />
          <PolicyOptionCard
            title="仅好友可见 (Friends)"
            desc="仅已添加的好友与所有者可以在搜索中检索到此 Bot。"
            selected={visibility === "friends"}
            onClick={() => setVisibility("friends")}
          />
          <PolicyOptionCard
            title="完全隐藏 (Private)"
            desc="从全局搜索中完全隐藏，仅所有者可在控制台查看与使用。"
            selected={visibility === "private"}
            onClick={() => setVisibility("private")}
          />
        </div>
      </div>

      {/* Friend Request Policy */}
      <div className="p-5 rounded-lg bg-surface-elevated/40 space-y-4">
        <div>
          <h3 className="text-regular font-bold text-content-strong flex items-center gap-2">
            <UserCheck className="h-4 w-4 text-accent-400" />
            好友申请处理 (Friend Requests)
          </h3>
          <p className="mt-1 text-compact text-content-muted">
            控制其他用户申请添加此 Bot 为好友时的处理策略。
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <PolicyOptionCard
            title="自动通过 (Open)"
            desc="其他用户添加申请即刻自动同意，并立即开启 1v1 私聊会话。"
            selected={friendPolicy === "open"}
            onClick={() => setFriendPolicy("open")}
            recommended
          />
          <PolicyOptionCard
            title="需我确认 (Require Approval)"
            desc="申请将转发至你的通知中心，由你代为同意或拒绝。"
            selected={friendPolicy === "require_approval"}
            onClick={() => setFriendPolicy("require_approval")}
          />
          <PolicyOptionCard
            title="禁止添加 (Disabled)"
            desc="关闭好友申请通道，任何用户均无法向此 Bot 发送申请。"
            selected={friendPolicy === "disabled"}
            onClick={() => setFriendPolicy("disabled")}
          />
        </div>
      </div>

      {/* Channel Invite Policy */}
      <div className="p-5 rounded-lg bg-surface-elevated/40 space-y-4">
        <div>
          <h3 className="text-regular font-bold text-content-strong flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-accent-400" />
            频道拉群规则 (Channel Invitations)
          </h3>
          <p className="mt-1 text-compact text-content-muted">
            控制协作者将此 Bot 邀请进频道/群组时的授权规则。
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <PolicyOptionCard
            title="直接加入 (Direct Join)"
            desc="任何好友或频道成员均可直接将 Bot 拉入对应频道。"
            selected={invitePolicy === "open"}
            onClick={() => setInvitePolicy("open")}
          />
          <PolicyOptionCard
            title="需我确认 (Require Approval)"
            desc="邀请将发送至你的活动通知，需所有者确认后 Bot 才会入群。"
            selected={invitePolicy === "require_approval"}
            onClick={() => setInvitePolicy("require_approval")}
            recommended
          />
        </div>
      </div>

      {/* Bottom Save Bar */}
      <div className="flex items-center justify-end gap-3 pt-2">
        {isDirty && (
          <span className="text-compact text-accent-400">
            Unsaved changes
          </span>
        )}
        <Button
          action="done"
          variant="primary"
          controlSize="regular"
          disabled={!isDirty || saving}
          onClick={handleSave}
        >
          {saving ? "Saving…" : "Save Policy Changes"}
        </Button>
      </div>
    </div>
  );
}

function PolicyOptionCard({
  title,
  desc,
  selected,
  onClick,
  recommended,
}: {
  title: string;
  desc: string;
  selected: boolean;
  onClick: () => void;
  recommended?: boolean;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "cursor-pointer rounded-lg p-4 transition-all relative flex flex-col justify-between",
        selected
          ? "bg-zinc-800 text-content-strong ring-1 ring-accent-400/80 shadow-sm"
          : "bg-surface-elevated/60 text-content-primary hover:bg-zinc-800/50 hover:text-content-strong"
      )}
    >
      <div>
        <div className="flex items-center justify-between gap-2">
          <span className="font-bold text-compact text-content-strong">{title}</span>
          {recommended && (
            <span className="text-minimal px-2 py-1 rounded bg-accent-500/10 text-accent-400">
              Recommended
            </span>
          )}
        </div>
        <p className="mt-2 text-minimal text-content-muted leading-relaxed">
          {desc}
        </p>
      </div>
      <div className="mt-3 flex justify-end">
        <div
          className={cn(
            "w-5 h-5 rounded flex items-center justify-center transition-colors",
            selected
              ? "bg-accent-400 text-canvas shadow-sm"
              : "bg-surface-elevated/80"
          )}
        >
          {selected && <Check className="w-4 h-4 stroke-[2.5]" />}
        </div>
      </div>
    </div>
  );
}

// ── Tab 2: Operational Permissions ─────────────────────────────────────────────

function OperationalPermissionsTab({ botId }: { botId: string }) {
  const [approvers, setApprovers] = useState<ApproverInfo[]>([]);
  const [loadingApprovers, setLoadingApprovers] = useState(true);
  const [revokingKey, setRevokingKey] = useState<string | null>(null);

  const loadDelegates = useCallback(() => {
    setLoadingApprovers(true);
    listApprovers(botId)
      .then((res) => {
        setApprovers(res.delegates || []);
      })
      .catch(() => toast.error("Failed to load approval delegates"))
      .finally(() => setLoadingApprovers(false));
  }, [botId]);

  useEffect(() => {
    loadDelegates();
  }, [loadDelegates]);

  async function handleRevoke(app: ApproverInfo) {
    if (!app.channel_id) return;
    const key = `${app.user_id}:${app.channel_id}:${app.operation_kind}`;
    setRevokingKey(key);
    try {
      await revokeApprover(botId, app.channel_id, app.user_id, app.operation_kind || "*");
      toast.success("Approver delegation revoked");
      loadDelegates();
    } catch {
      toast.error("Failed to revoke delegation");
    } finally {
      setRevokingKey(null);
    }
  }

  return (
    <div className="space-y-8">
      {/* Section 1: Execution Posture & Native Security */}
      <div className="p-5 rounded-lg bg-surface-elevated/40 space-y-4">
        <div>
          <h3 className="text-regular font-bold text-content-strong flex items-center gap-2">
            <Radio className="h-4 w-4 text-accent-400" />
            执行姿态与原生安全模式 (Execution Posture)
          </h3>
          <p className="mt-1 text-compact text-content-muted">
            配置 Agent 连接时所使用的安全与审批模式。
          </p>
        </div>
        <BotPostureSection botId={botId} />
      </div>

      {/* Section 2: Approver Delegations */}
      <div className="p-5 rounded-lg bg-surface-elevated/40 space-y-4">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h3 className="text-regular font-bold text-content-strong flex items-center gap-2">
              <Shield className="h-4 w-4 text-accent-400" />
              审批代理人委派 (Approval Delegations)
            </h3>
            <p className="mt-1 text-compact text-content-muted">
              除了你作为 Bot Owner 拥有全权审批资格外，你还可以授权特定协作者在指定频道代为审批工具调用。
            </p>
          </div>
        </div>

        {loadingApprovers ? (
          <SurfaceSpinner />
        ) : approvers.length === 0 ? (
          <EmptyState
            title="暂无额外的委派记录"
            hint="当前仅有你（所有者）可以审批此 Bot 的敏感工具调用。"
            className="p-6 rounded-md bg-surface-elevated/20"
          />
        ) : (
          <div className="space-y-2">
            {approvers.map((app) => {
              const key = `${app.user_id}:${app.channel_id}:${app.operation_kind}`;
              const isRevoking = revokingKey === key;
              return (
                <div
                  key={key}
                  className="flex items-center justify-between p-3 rounded-md bg-surface-elevated/60 text-compact"
                >
                  <div className="min-w-0 flex items-center gap-3">
                    <Avatar name={app.display_name || app.username || app.user_id} size="small" />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-content-strong">
                          {app.display_name || app.username || "User"}
                        </span>
                        {app.username && (
                          <span className="text-minimal text-content-muted">@{app.username}</span>
                        )}
                        <Badge tone="accent">
                          {app.operation_kind === "*" ? "全部操作 (*)" : app.operation_kind}
                        </Badge>
                      </div>
                      <p className="text-minimal text-content-muted mt-1">
                        频道: {app.channel_name ? `#${app.channel_name}` : app.channel_id} · 授权于:{" "}
                        {app.granted_at ? new Date(app.granted_at).toLocaleDateString() : "未知"}
                      </p>
                    </div>
                  </div>

                  {app.channel_id && (
                    <Button
                      action="remove"
                      variant="danger"
                      controlSize="compact"
                      disabled={isRevoking}
                      onClick={() => handleRevoke(app)}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      {isRevoking ? "Revoking…" : "Revoke"}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Section 3: Fine-grained Event Access Control */}
      <div className="p-5 rounded-lg bg-surface-elevated/40 space-y-4">
        <div>
          <h3 className="text-regular font-bold text-content-strong flex items-center gap-2">
            <Lock className="h-4 w-4 text-accent-400" />
            高级事件访问控制 (ACP Event Access Matrix)
          </h3>
          <p className="mt-1 text-compact text-content-muted">
            细粒度管理各角色与用户在各频道的 INITIATE (发起)、SEE (观察)、RESPOND (应答) 权限。
          </p>
        </div>
        <BotPermissionGrantsSection botId={botId} />
      </div>
    </div>
  );
}

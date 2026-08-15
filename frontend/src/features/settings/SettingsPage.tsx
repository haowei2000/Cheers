import { Button as UiButton } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  User,
  Bot,
  Blocks,
  Users,
  LogOut,
  AudioLines,
  ShieldAlert,
  Info,
  Server,
  Palette,
} from "lucide-react";
import { useAuthStore, useIsAdmin } from "@/stores/authStore";
import { logout as logoutApi } from "@/api/auth";
import { disablePush } from "@/lib/push";
import { isTauri } from "@/lib/serverConfig";
import { ActionButton } from "@/components/ui/action-button";
import { WorkbenchManager } from "@/features/workbench/WorkbenchManager";
import { AdminUsers } from "./AdminUsers";
import { AdminSttSettings } from "./AdminSttSettings";
import { AdminReports } from "./AdminReports";
import { PasskeyCard, TwoFactorCard } from "./SecurityCards";
import { RouteChromeHeader } from "@/features/desktop/RouteChromeHeader";
import { ProfileEditCard } from "./ProfileSettings";
import {
  AppearanceCard,
  AppUpdateCard,
  LaunchAtLoginCard,
  PushNotificationsCard,
  ServerCard,
} from "./GeneralSettings";
import {
  ChangePasswordAction,
  DeleteAccountAction,
  DevicesSessionsCard,
  ExternalAIPermissionsCard,
  ExternalIdentitiesCard,
  ForgotPasswordAction,
  LegalLinks,
  SignOutAction,
} from "./AccountSettings";

type SectionId =
  | "profile"
  | "appearance"
  | "bots"
  | "server"
  | "about"
  | "workbench"
  | "members"
  | "speech"
  | "reports"
  | "account";

const NAV: {
  id: SectionId;
  label: string;
  icon: typeof User;
  adminOnly?: boolean;
  /** Only meaningful inside the Tauri desktop shell. */
  desktopOnly?: boolean;
}[] = [
  { id: "profile", label: "Profile", icon: User },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "bots", label: "Bots", icon: Bot },
  { id: "server", label: "Server", icon: Server },
  { id: "about", label: "About", icon: Info, desktopOnly: true },
  { id: "workbench", label: "Workbench", icon: Blocks, adminOnly: true },
  { id: "members", label: "Members", icon: Users, adminOnly: true },
  { id: "speech", label: "Speech-to-text", icon: AudioLines, adminOnly: true },
  { id: "reports", label: "Safety reports", icon: ShieldAlert, adminOnly: true },
  { id: "account", label: "Account", icon: LogOut },
];

function BotsMovedCard() {
  const navigate = useNavigate();
  return (
    <div className="bg-zinc-900 rounded-sm p-6">
      <div className="flex items-center gap-2 mb-2">
        <Bot className="w-4 h-4 text-accent-300" />
        <p className="text-regular font-medium text-content-secondary">Bots live in Fleet</p>
      </div>
      <p className="text-compact text-content-muted mb-4">
        Create and manage bots from Fleet — the primary home for your agent roster.
      </p>
      <ActionButton action="open" context="settings" accessibleLabel="Open Fleet" onClick={() => navigate("/fleet")} />
    </div>
  );
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);
  const setToken = useAuthStore((s) => s.setToken);
  const isAdmin = useIsAdmin();
  const params = useParams();

  const items = NAV.filter(
    (n) => (!n.adminOnly || isAdmin) && (!n.desktopOnly || isTauri())
  );

  // Section lives in the URL (/settings/:section) so reload restores it, each
  // section is deep-linkable, and Back steps between sections. Fall back to the
  // first section for an unknown or admin-gated path.
  const requested = (params["*"] ?? "").split("/")[0];
  const section: SectionId = items.some((n) => n.id === requested)
    ? (requested as SectionId)
    : "profile";

  return (
    // h-full + internal scroll: the app root is overflow-hidden, so the page must own
    // its scrolling (min-h-screen alone would clip anything taller than the viewport,
    // and h-screen=100vh overflows the 100dvh root on mobile browsers).
    <div className="h-full overflow-y-auto overscroll-contain bg-canvas text-content-primary">
      <RouteChromeHeader>
        <div className="px-6 max-md:px-4 py-5 flex items-center gap-4">
          <UiButton variant="plain"
            type="button"
            content="icon"
            controlSize="regular"
            onClick={() => navigate("/chat")}
            title="Back to chat"
            aria-label="Back to chat"
            className="text-content-primary hover:text-content-strong transition-colors rounded-sm"
          >
            <ArrowLeft className="w-5 h-5" aria-hidden="true" />
          </UiButton>
          <h1 className="text-comfortable font-semibold">Settings</h1>
        </div>
      </RouteChromeHeader>

      <div className="max-w-5xl mx-auto p-6 max-md:p-4 max-md:pb-[calc(1.5rem+env(safe-area-inset-bottom))] flex flex-col sm:flex-row gap-6">
        {/* Nav rail */}
        <nav className="flex sm:flex-col gap-1 sm:w-48 sm:shrink-0 overflow-x-auto">
          {items.map(({ id, label, icon: Icon }) => {
            const active = section === id;
            return (
              <UiButton content="iconText" variant="plain" selected={active} role="tab" aria-selected={active}
                key={id}
                type="button"
                onClick={() => navigate(`/settings/${id}`)}
                aria-current={active ? "page" : undefined}
                controlSize="regular" className={cn(
                  "flex items-center gap-3 rounded-sm shrink-0 font-medium whitespace-nowrap transition-colors",
                  !active && "text-content-primary hover:bg-control hover:text-content-strong",
                )}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {label}
              </UiButton>
            );
          })}
        </nav>

        {/* Active section */}
        <div className="flex-1 min-w-0">
          {section === "profile" && (
            <section>
              <h2 className="text-compact font-semibold text-content-muted uppercase tracking-section mb-4 flex items-center gap-2">
                <User className="w-3.5 h-3.5" />
                Profile
              </h2>

              <ProfileEditCard />
            </section>
          )}

          {section === "appearance" && <AppearanceCard />}

          {section === "bots" && <BotsMovedCard />}

          {section === "server" && (
            <section>
              <h2 className="text-compact font-semibold text-content-muted uppercase tracking-section mb-4">
                Server
              </h2>
              <ServerCard />
            </section>
          )}

          {section === "about" && (
            <section>
              <h2 className="text-compact font-semibold text-content-muted uppercase tracking-section mb-4">
                About
              </h2>
              <AppUpdateCard />
              <LaunchAtLoginCard />
            </section>
          )}

          {/* Admin-only; each self-gates (renders null for non-admins). */}
          {section === "workbench" && <WorkbenchManager />}
          {section === "members" && <AdminUsers />}
          {section === "reports" && <AdminReports />}
          {section === "speech" && <AdminSttSettings />}

          {section === "account" && (
            <section>
              <h2 className="mb-5 text-compact font-semibold uppercase tracking-section text-content-muted">
                Account
              </h2>

              <div className="bg-zinc-900 px-6 max-md:px-4">
                <section className="py-5 first:pt-0">
                  <p className="text-title text-content-secondary">Account actions</p>
                  <p className="mt-1 text-caption">
                    Open an action when you need it. Security details stay hidden until then.
                  </p>
                  <div className="mt-4 grid grid-cols-2 gap-2 max-md:grid-cols-1">
                    <ChangePasswordAction onRotated={(token) => setToken(token)} />
                    <ForgotPasswordAction />
                    <TwoFactorCard />
                    <DeleteAccountAction
                      onDeleted={() => {
                        logout();
                        navigate("/login", { replace: true });
                      }}
                    />
                    <SignOutAction
                      onSignOut={async () => {
                        // Push first (the DELETE needs the auth token), then
                        // best-effort server revocation, then clear local state.
                        await disablePush().catch(() => {});
                        await logoutApi().catch(() => {});
                        logout();
                        navigate("/login", { replace: true });
                      }}
                    />
                  </div>
                </section>

                <PasskeyCard />

                <ExternalIdentitiesCard />

                <DevicesSessionsCard />

                <ExternalAIPermissionsCard />

                {/* Desktop shell: also linked from About — keep a copy here so
                    Account remains a one-stop for signed-in session controls. */}
                <AppUpdateCard />

                <PushNotificationsCard />

              </div>

              <LegalLinks />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

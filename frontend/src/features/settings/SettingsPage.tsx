import { ContentActionScope } from "@/components/ui/content-action-scope";
import { useNavigate, useParams } from "react-router-dom";
import {
  User,
  Bot,
  Blocks,
  Users,
  LogOut,
  AudioLines,
  ShieldAlert,
  Info,
  Server,
  CalendarClock,
  Palette,
  ArrowLeft,
  Sliders,
} from "lucide-react";
import { useAuthStore, useIsAdmin } from "@/stores/authStore";
import { logout as logoutApi } from "@/api/auth";
import { disablePush } from "@/lib/push";
import { isTauri } from "@/lib/serverConfig";
import { ActionButton } from "@/components/ui/action-button";
import { IconButton } from "@/components/ui/icon-button";
import { WorkbenchManager } from "@/features/workbench/WorkbenchManager";
import { ScheduledMessagesManager } from "@/features/scheduled/ScheduledMessagesManager";
import { AdminUsers } from "./AdminUsers";
import { AdminSttSettings } from "./AdminSttSettings";
import { AdminReports } from "./AdminReports";
import { PasskeyCard, TrustedDevicesCard, TwoFactorCard } from "./SecurityCards";
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
  EmailAction,
  ExternalAIPermissionsCard,
  ExternalIdentitiesCard,
  LegalLinks,
  SignOutAction,
} from "./AccountSettings";
import { ItemList, NavigationItem } from "@/components/ui/item";
import { SettingsCard, SettingsCardSection, SettingsSection } from "@/components/ui/settings-card";

type SectionId =
  | "profile"
  | "appearance"
  | "bots"
  | "server"
  | "about"
  | "workbench"
  | "scheduled"
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
  { id: "workbench", label: "Workbench", icon: Blocks },
  { id: "scheduled", label: "Scheduled tasks", icon: CalendarClock },
  { id: "members", label: "Members", icon: Users, adminOnly: true },
  { id: "speech", label: "Speech-to-text", icon: AudioLines, adminOnly: true },
  { id: "reports", label: "Safety reports", icon: ShieldAlert, adminOnly: true },
  { id: "account", label: "Account", icon: LogOut },
];

function BotsMovedCard() {
  const navigate = useNavigate();
  return (
    <SettingsSection title="Bots" icon={Bot}>
      <SettingsCard
        title="Bots live in Fleet"
        description="Create and manage bots from Fleet — the primary home for your agent roster."
        actions={<ActionButton action="open" context="settings" accessibleLabel="Open Fleet" onClick={() => navigate("/fleet")} />}
      />
    </SettingsSection>
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
        <header className="mx-auto flex w-full max-w-5xl items-center gap-4 px-6 py-5 max-md:px-4">
          <IconButton
            label="Back to chat"
            onClick={() => navigate("/chat")}
            controlSize="regular"
            className="rounded-sm text-content-primary transition-colors hover:text-content-strong"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          </IconButton>
          <Sliders className="h-4 w-4 text-accent-400" aria-hidden="true" />
          <div>
            <h1 className="font-serif text-regular font-bold tracking-tight text-content-strong leading-none">Settings</h1>
            <p className="mt-1 hidden text-minimal text-content-muted sm:block">Preferences and workspace configuration</p>
          </div>
        </header>
      </RouteChromeHeader>

      <div className="max-w-5xl mx-auto p-6 max-md:p-4 max-md:pb-[calc(1.5rem+env(safe-area-inset-bottom))] flex flex-col sm:flex-row gap-6">
        {/* Nav rail */}
        <nav aria-label="Settings sections" className="sm:w-48 sm:shrink-0">
          <ItemList
            presentationLevel="minimal"
            controlSize="regular"
            className="flex gap-1 overflow-x-auto sm:flex-col"
          >
            {items.map(({ id, label, icon: Icon }) => {
              const active = section === id;
              return (
                <NavigationItem
                  key={id}
                  title={label}
                  leading={<Icon className="h-4 w-4" aria-hidden="true" />}
                  selected={active}
                  onClick={() => navigate(`/settings/${id}`)}
                  className="shrink-0 max-sm:w-auto"
                />
              );
            })}
          </ItemList>
        </nav>

        {/* Active section */}
        <div className="flex-1 min-w-0">
          <ContentActionScope>
          {section === "profile" && (
            <SettingsSection title="Profile" icon={User}>
              <SettingsCard
                title="Public profile"
                description="Choose how you appear to other people in Cheers."
              >
                <ProfileEditCard />
              </SettingsCard>
            </SettingsSection>
          )}

          {section === "appearance" && <AppearanceCard />}

          {section === "bots" && <BotsMovedCard />}

          {section === "server" && (
            <SettingsSection title="Server" icon={Server}>
              <ServerCard />
            </SettingsSection>
          )}

          {section === "about" && (
            <SettingsSection title="About" icon={Info}>
              <AppUpdateCard />
              <LaunchAtLoginCard />
              <LegalLinks />
            </SettingsSection>
          )}

          {/* Admin-only; each self-gates (renders null for non-admins). */}
          {section === "workbench" && <WorkbenchManager />}
          {section === "scheduled" && <ScheduledMessagesManager />}
          {section === "members" && <AdminUsers />}
          {section === "reports" && <AdminReports />}
          {section === "speech" && <AdminSttSettings />}

          {section === "account" && (
            <SettingsSection title="Account" icon={LogOut}>
              <SettingsCard
                title="Sign-in and security"
                description="Manage how you sign in and verify sensitive actions."
              >
                  <ItemList presentationLevel="max" controlSize="regular">
                    <EmailAction />
                    <ChangePasswordAction onRotated={(token) => setToken(token)} />
                    <TwoFactorCard />
                  </ItemList>

                  <PasskeyCard />

                  <ExternalIdentitiesCard />

                  <TrustedDevicesCard />

                  <DevicesSessionsCard />

                  <ExternalAIPermissionsCard />

                  <PushNotificationsCard />

                  <SettingsCardSection
                    title="Account access"
                    description="End this session or permanently remove your account."
                  >
                  <ItemList presentationLevel="max" controlSize="regular">
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
                    <DeleteAccountAction
                      onDeleted={() => {
                        logout();
                        navigate("/login", { replace: true });
                      }}
                    />
                  </ItemList>
                  </SettingsCardSection>
              </SettingsCard>

              <LegalLinks />
            </SettingsSection>
          )}
          </ContentActionScope>
        </div>
      </div>
    </div>
  );
}

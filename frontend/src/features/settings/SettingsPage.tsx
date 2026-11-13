import { PageLayout } from "@/components/ui/page-layout";
import { SectionNav } from "@/components/ui/section-nav";
import { ContentActionScope } from "@/components/ui/content-action-scope";
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  User,
  Blocks,
  Users,
  LogOut,
  AudioLines,
  ShieldAlert,
  Info,
  CalendarClock,
  Palette,
  Sliders,
  SlidersHorizontal,
} from "lucide-react";
import { useAuthStore, useIsAdmin } from "@/stores/authStore";
import { logout as logoutApi } from "@/api/auth";
import { disablePush } from "@/lib/push";
import { isTauri } from "@/lib/serverConfig";
import { WorkbenchManager } from "@/features/workbench/WorkbenchManager";
import { ScheduledMessagesManager } from "@/features/scheduled/ScheduledMessagesManager";
import { AdminUsers } from "./AdminUsers";
import { AdminSttSettings } from "./AdminSttSettings";
import { AdminRuntimeSettings } from "./AdminRuntimeSettings";
import { AdminReports } from "./AdminReports";
import { PasskeyCard, TrustedDevicesCard, TwoFactorCard } from "./SecurityCards";
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
import { ItemList } from "@/components/ui/item";
import { SettingsCard, SettingsCardSection, SettingsSection } from "@/components/ui/settings-card";

type SectionId =
  | "profile"
  | "general"
  | "appearance"
  | "bots"
  | "server"
  | "about"
  | "workbench"
  | "scheduled"
  | "members"
  | "speech"
  | "runtime"
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
  { id: "general", label: "General", icon: Sliders },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "about", label: "About", icon: Info, desktopOnly: true },
  { id: "workbench", label: "Workbench extensions", icon: Blocks },
  { id: "scheduled", label: "Scheduled tasks", icon: CalendarClock },
  { id: "members", label: "Members", icon: Users, adminOnly: true },
  { id: "speech", label: "Speech-to-text", icon: AudioLines, adminOnly: true },
  { id: "runtime", label: "Runtime settings", icon: SlidersHorizontal, adminOnly: true },
  { id: "reports", label: "Safety reports", icon: ShieldAlert, adminOnly: true },
  { id: "account", label: "Account", icon: LogOut },
];

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
  const resolvedRequested = requested === "server" ? "general" : requested;
  const section: SectionId = requested === "bots"
    ? "bots"
    : items.some((n) => n.id === resolvedRequested)
    ? (resolvedRequested as SectionId)
    : "profile";
  useEffect(() => {
    if (section === "bots") navigate("/fleet", { replace: true });
  }, [navigate, section]);

  if (section === "bots") return null;

  return (
    // h-full + internal scroll: the app root is overflow-hidden, so the page must own
    // its scrolling (min-h-screen alone would clip anything taller than the viewport,
    // and h-screen=100vh overflows the 100dvh root on mobile browsers).
    <PageLayout title="Settings" icon={Sliders} description="Preferences and workspace configuration" navigation={<SectionNav
          ariaLabel="Settings sections"
          items={items}
          selected={section}
          onSelect={(id) => navigate(`/settings/${id}`)}
        />}>
{/* Active section */}
        <div className="flex-1 min-w-0">
          <ContentActionScope>
          {/* Keep the editor mounted while navigating settings sections so an
              in-progress profile draft survives the section change. */}
          <div hidden={section !== "profile"}>
            <SettingsSection title="Profile" icon={User}>
              <SettingsCard
                title="Public profile"
                description="Choose how you appear to other people in Cheers."
              >
                <ProfileEditCard />
              </SettingsCard>
            </SettingsSection>
          </div>

          {section === "appearance" && <AppearanceCard />}

          {section === "general" && (
            <SettingsSection title="General" icon={Sliders}>
              <ServerCard />
              <LaunchAtLoginCard />
              <PushNotificationsCard />
            </SettingsSection>
          )}

          {section === "about" && (
            <SettingsSection title="About" icon={Info}>
              <AppUpdateCard />
              <LegalLinks />
            </SettingsSection>
          )}

          {/* Admin-only; each self-gates (renders null for non-admins). */}
          {section === "workbench" && <WorkbenchManager />}
          {section === "scheduled" && <ScheduledMessagesManager />}
          {section === "members" && <AdminUsers />}
          {section === "reports" && <AdminReports />}
          {section === "speech" && <AdminSttSettings />}
          {section === "runtime" && <AdminRuntimeSettings />}

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
    </PageLayout>
  );
}

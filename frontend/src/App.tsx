import { lazy, Suspense, useEffect } from "react";
import { Lock } from "lucide-react";
import toast from "react-hot-toast";
import { Spinner as LoadingIcon } from "@/components/ui/spinner";
import {
  Routes,
  Route,
  Navigate,
  useNavigate,
  useLocation,
} from "react-router-dom";
import { ErrorState } from "@/components/ui/error-state";
import { useAuthStore } from "@/stores/authStore";

const LoginPage = lazy(() => import("@/features/auth/LoginPage"));
const RegisterPage = lazy(() => import("@/features/auth/RegisterPage"));
const ForgotPasswordPage = lazy(() => import("@/features/auth/ForgotPasswordPage"));
const ResetPasswordPage = lazy(() => import("@/features/auth/ResetPasswordPage"));
const InvitePage = lazy(() => import("@/features/invite/InvitePage"));
const ChatLayout = lazy(() => import("@/features/chat/ChatLayout"));
const SettingsPage = lazy(() => import("@/features/settings/SettingsPage"));
const FriendsPage = lazy(() => import("@/features/friends/FriendsPage"));
const FleetPage = lazy(() => import("@/features/fleet/FleetPage"));

function Spinner() {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <LoadingIcon size={24} className="text-zinc-600" />
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const location = useLocation();
  if (!user) {
    // Carry the intended destination so signing in lands back here instead of
    // dumping the user at the default /chat (LoginPage consumes ?redirect=).
    const here = location.pathname + location.search;
    return (
      <Navigate to={`/login?redirect=${encodeURIComponent(here)}`} replace />
    );
  }
  return <>{children}</>;
}

// Tier-L takeover for an expired session (set by the api client / ws hooks on a
// rejected token). Covers the whole app so the user can't keep operating a dead
// session; "Sign in again" bounces through /login and back to where they were.
function SessionExpiredTakeover() {
  const expired = useAuthStore((s) => s.sessionExpired && s.user !== null);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const location = useLocation();

  // The 401s that tripped this takeover usually also fired their call sites'
  // error toasts (some land after we mount). Sweep the existing ones; the
  // overlay's z-index sits above the Toaster (9999) so stragglers stay hidden.
  useEffect(() => {
    if (expired) toast.dismiss();
  }, [expired]);

  if (!expired) return null;

  const signInAgain = () => {
    const here = location.pathname + location.search;
    // Navigate BEFORE clearing auth: logout() re-renders RequireAuth with a null
    // user, whose <Navigate to="/login"> would otherwise race us and clobber the
    // ?redirect= query.
    navigate(`/login?redirect=${encodeURIComponent(here)}`, { replace: true });
    logout();
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Session expired"
      className="fixed inset-0 z-[10000] bg-zinc-950 flex items-center justify-center"
    >
      <ErrorState
        icon={Lock}
        tone="warning"
        title="Session expired"
        description="Sign in again to pick up where you left off."
        action={{ label: "Sign in again", onClick: signInAgain }}
      />
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot" element={<ForgotPasswordPage />} />
        <Route path="/reset" element={<ResetPasswordPage />} />
        {/* Public: the landing page itself routes signed-out visitors to auth. */}
        <Route path="/invite/:token" element={<InvitePage />} />
        {/* The open workspace/channel live in the path so they survive a reload and
            can be shared as a link; both are optional because /chat is the generic
            entry point (ChatLayout then redirects to the personal workspace). */}
        <Route
          path="/chat/:workspaceId?/:channelId?"
          element={
            <RequireAuth>
              <ChatLayout />
            </RequireAuth>
          }
        />
        <Route
          path="/settings/*"
          element={
            <RequireAuth>
              <SettingsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/friends/*"
          element={
            <RequireAuth>
              <FriendsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/fleet"
          element={
            <RequireAuth>
              <FleetPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
      <SessionExpiredTakeover />
    </Suspense>
  );
}

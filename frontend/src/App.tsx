import { lazy, Suspense } from "react";
import { Spinner as LoadingIcon } from "@/components/ui/spinner";
import { Routes, Route, Navigate } from "react-router-dom";
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
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
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
        <Route
          path="/chat/*"
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
    </Suspense>
  );
}

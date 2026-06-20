import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";

const LoginPage = lazy(() => import("@/features/auth/LoginPage"));
const ChatLayout = lazy(() => import("@/features/chat/ChatLayout"));
const SettingsPage = lazy(() => import("@/features/settings/SettingsPage"));

function Spinner() {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <div className="w-6 h-6 border-2 border-zinc-700 border-t-indigo-500 rounded-full animate-spin" />
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
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
    </Suspense>
  );
}

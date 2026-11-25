import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Routes, Route, Link } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "./theme";
import { ActionButton } from "./action-button";
import { useAuthStore } from "@/stores/authStore";
import { useActivityUiStore } from "@/stores/activityUiStore";
import PermissionsPage from "@/features/permissions/PermissionsPage";
import ActivityPage from "@/features/activity/ActivityPage";
import FriendsPage from "@/features/friends/FriendsPage";
import FleetPage from "@/features/fleet/FleetPage";
import SettingsPage from "@/features/settings/SettingsPage";
import { ActivityCenter } from "@/features/chat/NotificationCenter";
import { NewWorkspaceDialog } from "@/features/chat/NewWorkspaceDialog";
import { panelsFor } from "@/features/chat/panels/registry";
import "@/features/chat/workbench/panels/AuditPanel";
import "@/index.css";

useAuthStore.setState({ user: { user_id: "preview-owner", username: "owner", display_name: "Owner", role: "admin" }, initialized: true });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Preview() {
  const [workspace, setWorkspace] = useState(false);
  return <div className="flex h-dvh flex-col bg-canvas text-content-primary">
    <nav aria-label="Preview pages" className="flex shrink-0 flex-wrap items-center gap-3 px-4 py-2 font-utility text-regular">
      {["permissions", "friends", "fleet", "settings/profile", "settings/scheduled", "activity"].map(path => <Link key={path} to={`/${path}`} className="underline underline-offset-4">{path}</Link>)}
      <ActionButton action="add" context="toolbar" accessibleLabel="New workspace" onClick={() => setWorkspace(true)} />
      <ActionButton action="open" context="settings" accessibleLabel="Open Activity dialog" onClick={() => useActivityUiStore.getState().setOpen(true)} />
      <ActivityCenter />
    </nav>
    <div className="min-h-0 flex-1"><Routes>
      <Route path="/permissions" element={<PermissionsPage />} />
      <Route path="/friends/*" element={<FriendsPage />} />
      <Route path="/fleet/*" element={<FleetPage />} />
      <Route path="/settings/*" element={<SettingsPage />} />
      <Route path="/activity" element={<ActivityPage />} />
      <Route path="/audit" element={panelsFor("lane").find(panel => panel.id === "audit")?.render({ channelId: "channel-1", visible: true })} />
    </Routes></div>
    {workspace && <NewWorkspaceDialog onClose={() => setWorkspace(false)} />}
  </div>;
}
const initial = new URLSearchParams(location.search).get("route") || "/permissions";
createRoot(document.getElementById("root")!).render(<ThemeProvider><QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[initial]}><Preview /></MemoryRouter></QueryClientProvider></ThemeProvider>);

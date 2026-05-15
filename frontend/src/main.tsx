import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "react-hot-toast";
import { BrowserRouter, Navigate, Routes, Route } from "react-router-dom";
import "./styles/design-tokens.css";
import "./styles/composer.css";
import "./index.css";

const App = lazy(() => import("./App"));
const DocsPage = lazy(() => import("./DocsPage"));
const BulletinPage = lazy(() => import("./BulletinPage"));

function RouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-0)] text-sm text-[var(--fg-3)]">
      加载中...
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Toaster position="top-center" />
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="/workspaces/:workspaceId" element={<App />} />
          <Route path="/workspaces/:workspaceId/channels/:channelId" element={<App />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="/bulletin" element={<BulletinPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </React.StrictMode>
);

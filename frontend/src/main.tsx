import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "react-hot-toast";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PresentationProvider } from "./components/ui/presentation";
import { ControlSizeProvider } from "./components/ui/control-size";
import "./index.css";

// PWA service worker (precached shell + Web Push, see src/sw.ts). immediate:
// update checks run on load; registerType autoUpdate swaps the SW in place.
// No-op in dev — vite-plugin-pwa devOptions are off.
registerSW({ immediate: true });

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 60_000,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ErrorBoundary>
          <PresentationProvider>
            <ControlSizeProvider size="regular">
              <App />
            </ControlSizeProvider>
          </PresentationProvider>
        </ErrorBoundary>
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              // Borderless popover surface (DESIGN.md §2.4): zinc-900 fill separated
              // by shadow, not an outline — matches `shadow-xl shadow-black/40`.
              background: "#18181b",
              color: "rgb(var(--text-strong))",
              boxShadow:
                "0 20px 25px -5px rgb(0 0 0 / 0.4), 0 8px 10px -6px rgb(0 0 0 / 0.4)",
              fontSize: "var(--type-regular-size)",
            },
          }}
        />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);

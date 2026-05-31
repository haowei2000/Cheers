import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_PROXY_TARGET = process.env.VITE_API_PROXY_TARGET || "http://localhost:8000";
const WS_PROXY_TARGET = process.env.VITE_WS_PROXY_TARGET || API_PROXY_TARGET.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://");

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_PUBLIC_BASE_PATH || "/",
  build: {
    // App entry and route chunks are already split. Mermaid 11.15's on-demand
    // rendering engine exceeds Vite's default 500 kB warning but is not in the
    // first-screen bundle.
    chunkSizeWarningLimit: 650,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API_PROXY_TARGET, changeOrigin: true },
      "/ws": { target: WS_PROXY_TARGET, ws: true },
      "/docs": { target: API_PROXY_TARGET, changeOrigin: true },
      "/health": { target: API_PROXY_TARGET, changeOrigin: true },
      "/manual": { target: API_PROXY_TARGET, changeOrigin: true },
    },
  },
});

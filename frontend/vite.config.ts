import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const API_PROXY_TARGET =
  process.env.VITE_API_PROXY_TARGET || "http://localhost:8000";
const WS_PROXY_TARGET =
  process.env.VITE_WS_PROXY_TARGET ||
  API_PROXY_TARGET.replace(/^http:\/\//, "ws://").replace(
    /^https:\/\//,
    "wss://"
  );

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  base: process.env.VITE_PUBLIC_BASE_PATH || "/",
  build: {
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      output: {
        manualChunks: {
          hljs: ["highlight.js"],
          markdown: ["react-markdown", "remark-gfm"],
          pdf: ["pdfjs-dist"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API_PROXY_TARGET, changeOrigin: true },
      "/ws": { target: WS_PROXY_TARGET, ws: true },
      "/docs": { target: API_PROXY_TARGET, changeOrigin: true },
      "/health": { target: API_PROXY_TARGET, changeOrigin: true },
    },
  },
});

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
          // Only the common-language grammar set rides the eager chat chunk
          // (MarkdownRenderer). The full highlight.js barrel is reachable solely
          // through the lazily-loaded FilePreviewModal, so its long-tail grammars
          // land in that async chunk instead of the critical path.
          hljs: ["highlight.js/lib/common"],
          markdown: ["react-markdown", "remark-gfm"],
          pdf: ["pdfjs-dist"],
        },
      },
    },
  },
  server: {
    // Honor a harness/CI-assigned port (preview autoPort sets PORT); default to 5173.
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    proxy: {
      "/api": { target: API_PROXY_TARGET, changeOrigin: true },
      "/ws": { target: WS_PROXY_TARGET, ws: true },
      "/docs": { target: API_PROXY_TARGET, changeOrigin: true },
      "/health": { target: API_PROXY_TARGET, changeOrigin: true },
    },
  },
});

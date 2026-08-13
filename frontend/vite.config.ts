import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FRONTEND_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEBSITE_DIR = path.resolve(FRONTEND_DIR, "../website");
const PUBLIC_POLICY_PAGES = [
  "privacy.html",
  "privacy.zh-CN.html",
  "support.html",
  "support.zh-CN.html",
  "terms.html",
  "account-deletion.html",
  "remote-operations.html",
  "remote-operations.zh-CN.html",
] as const;
const PUBLIC_POLICY_ASSETS = [
  ["favicon.svg", "favicon.svg"],
  ["editorial.css", "editorial.css"],
  ["assets/SourceSerif4Variable-Roman.ttf.woff2", "assets/SourceSerif4Variable-Roman.ttf.woff2"],
  ["assets/SourceSerif4-OFL.txt", "assets/SourceSerif4-OFL.txt"],
  ["assets/SourceHanSerifCN-VF.ttf.woff2", "assets/SourceHanSerifCN-VF.ttf.woff2"],
  ["assets/SourceHanSerif-OFL.txt", "assets/SourceHanSerif-OFL.txt"],
  ["assets/SourceSans3VF-Upright.ttf.woff2", "assets/SourceSans3VF-Upright.ttf.woff2"],
  ["assets/SourceSans3-OFL.txt", "assets/SourceSans3-OFL.txt"],
] as const;

/** Keep website/ authoritative while shipping the App Store public URLs from
 * the same Nginx origin as the app. This runs for local and Docker builds. */
function publicPolicyPages() {
  return {
    name: "cheers-public-policy-pages",
    apply: "build" as const,
    closeBundle() {
      const outputDir = path.resolve(FRONTEND_DIR, "dist");
      mkdirSync(outputDir, { recursive: true });
      for (const page of PUBLIC_POLICY_PAGES) {
        copyFileSync(path.join(WEBSITE_DIR, page), path.join(outputDir, page));
      }
      for (const [source, destination] of PUBLIC_POLICY_ASSETS) {
        const destinationPath = path.join(outputDir, destination);
        mkdirSync(path.dirname(destinationPath), { recursive: true });
        copyFileSync(path.join(WEBSITE_DIR, source), destinationPath);
      }
    },
  };
}

const API_PROXY_TARGET =
  process.env.VITE_API_PROXY_TARGET || "http://localhost:8000";
const WS_PROXY_TARGET =
  process.env.VITE_WS_PROXY_TARGET ||
  API_PROXY_TARGET.replace(/^http:\/\//, "ws://").replace(
    /^https:\/\//,
    "wss://"
  );

export default defineConfig({
  plugins: [
    react(),
    publicPolicyPages(),
    // PWA: installable app + Web Push. injectManifest (not generateSW) because
    // the service worker is hand-written (src/sw.ts) — push/notificationclick
    // handlers need app-specific logic, not just caching. The SW precaches the
    // app shell only; /api, /ws and /docs are never cached (realtime app).
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      // Registration happens in main.tsx via virtual:pwa-register (single place
      // that controls update behavior); no injected register script.
      injectRegister: false,
      manifest: {
        name: "Cheers",
        short_name: "Cheers",
        description: "Multi-agent chat workspace",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/pwa-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        // Keep the precache an actual app SHELL: the deliberately lazy-split
        // heavyweights (file preview, code editor, pdf, highlight grammars —
        // ~2 MB combined) load on demand exactly like without a SW, instead
        // of being downloaded by every client on every deploy.
        globIgnores: [
          "**/assets/FilePreviewModal-*.js",
          "**/assets/CodeEditor-*.js",
          "**/assets/pdf-*.js",
          "**/assets/hljs-*.js",
          "**/assets/pdf.worker*",
          // The 11 MB regional CJK font is fetched only when Chinese text is
          // rendered. Pre-caching it would penalize every PWA installation.
          "**/assets/SourceHanSerifCN-*.woff2",
        ],
      },
      // Dev runs without a SW (devOptions off): push testing happens against
      // the built image in kind, and a dev SW would only add cache confusion.
    }),
  ],
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
      "/mcp": { target: API_PROXY_TARGET, changeOrigin: true },
      "/.well-known/oauth-protected-resource": { target: API_PROXY_TARGET, changeOrigin: true },
      "/ws": { target: WS_PROXY_TARGET, ws: true },
      "/docs": { target: API_PROXY_TARGET, changeOrigin: true },
      "/health": { target: API_PROXY_TARGET, changeOrigin: true },
    },
  },
});

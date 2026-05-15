import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
    plugins: [react()],
    build: {
        // App entry and route chunks are already split. Mermaid 11.15's on-demand
        // rendering engine exceeds Vite's default 500 kB warning but is not in the
        // first-screen bundle.
        chunkSizeWarningLimit: 650,
    },
    server: {
        port: 5173,
        proxy: {
            "/api": { target: "http://localhost:8000", changeOrigin: true },
            "/ws": { target: "ws://localhost:8000", ws: true },
            "/docs": { target: "http://localhost:8000", changeOrigin: true },
            "/health": { target: "http://localhost:8000", changeOrigin: true },
            "/manual": { target: "http://localhost:8000", changeOrigin: true },
        },
    },
});

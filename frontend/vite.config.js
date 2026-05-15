import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
    plugins: [react()],
    build: {
        // 业务入口和路由 chunk 已拆小；Mermaid 11.15 的按需渲染引擎自身
        // 会超过 Vite 默认 500 kB 阈值，但不进入首屏主包。
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

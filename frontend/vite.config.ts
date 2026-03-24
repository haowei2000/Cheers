import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8002", changeOrigin: true },
      "/ws": { target: "ws://localhost:8002", ws: true },
      "/docs": { target: "http://localhost:8002", changeOrigin: true },
      "/health": { target: "http://localhost:8002", changeOrigin: true },
      "/manual": { target: "http://localhost:8002", changeOrigin: true },
    },
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// A workbench plugin must be ONE self-contained .html: the host stores it as a single
// bundle and mounts it as an iframe `srcdoc` with an opaque origin, where nothing can be
// fetched from a network path. viteSingleFile inlines every JS chunk and stylesheet into
// index.html so `npm run build` emits exactly that.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    // Keep the output honest about the 2 MiB server cap — React + ReactDOM is ~140 KB
    // gzipped, so real renderers land far below it, but a stray asset import can't be
    // silently split out into a second file.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
    // Readable output makes the shipped bundle auditable by whoever installs it.
    minify: "esbuild",
    target: "es2020",
    outDir: "dist",
    emptyOutDir: true,
  },
});

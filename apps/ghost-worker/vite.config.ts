import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  publicDir: "public",
  server: {
    port: 1420,
    strictPort: true,
    host: true,
    proxy: {
      "/daemon-api": {
        target: "http://127.0.0.1:7421",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/daemon-api/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});

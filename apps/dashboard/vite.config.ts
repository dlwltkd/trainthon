import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: "audience-entry",
    transformIndexHtml: html => process.env.VOUCH_PUBLIC_DEMO === "1"
      ? html.replace('<html lang="en">', '<html lang="ko" data-audience="true">')
      : html,
  }],
  resolve: {
    alias: {
      "@vouch/protocol": fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
});

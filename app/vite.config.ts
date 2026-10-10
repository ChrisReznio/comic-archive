import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectRegister: false,
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,woff2,wasm,svg,png}"],
        globIgnores: ["db/**"],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      manifest: {
        name: "Longbox: DC catalog",
        short_name: "Longbox",
        description: "Every DC issue and collected edition: track your collection, wishlist, compare editions and plan runs.",
        lang: "en",
        start_url: "./",
        scope: "./",
        display: "standalone",
        background_color: "#F4F6F8",
        theme_color: "#16181D",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  worker: { format: "es" },
  server: { host: true },
});

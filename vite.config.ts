import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [
    react(),
    mode === "development" && componentTagger(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: null,
      filename: "sw.js",
      devOptions: { enabled: false },
      manifest: {
        name: "eYe Pod System",
        short_name: "eYe",
        description: "Jackie · 24-pod compression intelligence system",
        theme_color: "#0a0a0a",
        background_color: "#0a0a0a",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/placeholder.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        // The PC embed under /pc-os/ is a complete build with its own service
        // worker, which precaches its own shell and route chunks from its own
        // .vite/manifest.json. Precaching it again here would duplicate ~26 MB
        // into Jackie's precache manifest and force a full re-download on every
        // PC rebuild — and it hard-fails the build outright, because the
        // on-device AI wasm is 21.6 MB against workbox's per-file limit.
        // Runtime caching below still picks these up on demand.
        globIgnores: ["**/pc-os/**"],
        navigateFallback: "/index.html",
        // /pc-os/index.html is a real navigation when the PC is opened in its
        // own tab. Without this it would fall back to Jackie's shell offline,
        // so the PC could not start standalone.
        navigateFallbackDenylist: [/^\/~oauth/, /^\/api/, /^\/functions/, /^\/pc-os\//],
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === "navigate",
            handler: "NetworkFirst",
            options: { cacheName: "eye-html", networkTimeoutSeconds: 4 },
          },
          {
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin && /\.(?:js|css|woff2?|ttf|otf|png|jpg|jpeg|svg|webp|gif|ico)$/.test(url.pathname),
            handler: "CacheFirst",
            options: {
              cacheName: "eye-assets",
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));

import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function offlineShellPlugin(): Plugin {
  let basePath = "/";
  return {
    name: "tradesight-offline-shell",
    configResolved(config) {
      basePath = config.base.endsWith("/") ? config.base : config.base + "/";
    },
    generateBundle(_options, bundle) {
      const bundledFiles = Object.keys(bundle).map((file) => basePath + file);
      const precache = [
        basePath,
        basePath + "index.html",
        basePath + "manifest.webmanifest",
        basePath + "icons/tradesight.svg",
        ...bundledFiles,
      ];
      const source = [
        'const CACHE_NAME = "tradesight-v2-shell-2";',
        "const BASE_PATH = " + JSON.stringify(basePath) + ";",
        "const PRECACHE_URLS = " + JSON.stringify([...new Set(precache)]) + ";",
        'const INDEX_URL = BASE_PATH + "index.html";',
        'const ASSET_PREFIX = BASE_PATH + "assets/";',
        'self.addEventListener("install", (event) => { event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())); });',
        'self.addEventListener("activate", (event) => { event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("tradesight-v2-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim())); });',
        'self.addEventListener("fetch", (event) => { const request = event.request; if (request.method !== "GET") return; const url = new URL(request.url); if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE_PATH)) return; if (request.mode === "navigate") { event.respondWith(fetch(request).then((response) => { const copy = response.clone(); caches.open(CACHE_NAME).then((cache) => cache.put(INDEX_URL, copy)); return response; }).catch(() => caches.match(INDEX_URL))); return; } if (PRECACHE_URLS.includes(url.pathname) || url.pathname.startsWith(ASSET_PREFIX)) { event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => { if (response.ok) { const copy = response.clone(); caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)); } return response; }))); } });',
      ].join("\n");
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const base = env.VITE_BASE_PATH || "/";
  return {
    base,
    plugins: [react(), offlineShellPlugin()],
    test: {
      environment: "node",
      include: ["src/**/*.test.ts"],
      coverage: {
        reporter: ["text", "html"],
        include: ["src/domain/**/*.ts"],
      },
    },
  };
});

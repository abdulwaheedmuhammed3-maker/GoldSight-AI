import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

function offlineShellPlugin(): Plugin {
  return {
    name: "tradesight-offline-shell",
    generateBundle(_options, bundle) {
      const bundledFiles = Object.keys(bundle).map((file) => "/" + file);
      const precache = ["/", "/index.html", "/manifest.webmanifest", "/icons/tradesight.svg", ...bundledFiles];
      const source = [
        'const CACHE_NAME = "tradesight-v2-shell-1";',
        "const PRECACHE_URLS = " + JSON.stringify([...new Set(precache)]) + ";",
        'self.addEventListener("install", (event) => { event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())); });',
        'self.addEventListener("activate", (event) => { event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("tradesight-v2-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim())); });',
        'self.addEventListener("fetch", (event) => { const request = event.request; if (request.method !== "GET") return; const url = new URL(request.url); if (url.origin !== self.location.origin) return; if (request.mode === "navigate") { event.respondWith(fetch(request).then((response) => { const copy = response.clone(); caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy)); return response; }).catch(() => caches.match("/index.html"))); return; } if (PRECACHE_URLS.includes(url.pathname) || url.pathname.startsWith("/assets/")) { event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => { if (response.ok) { const copy = response.clone(); caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)); } return response; }))); } });',
      ].join("\\n");
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  plugins: [react(), offlineShellPlugin()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
      include: ["src/domain/**/*.ts"],
    },
  },
});

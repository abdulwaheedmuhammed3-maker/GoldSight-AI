const CACHE_NAME = 'goldsight-shell-v1'
const APP_SHELL = ['/', '/manifest.webmanifest', '/goldsight-icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)

  // Never cache market data or API responses; stale prices/signals could mislead.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return

  // Network-first HTML lets deployed updates arrive; shell cache is the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match('/')) || Response.error())
    )
    return
  }

  if (url.pathname === '/manifest.webmanifest' || url.pathname === '/goldsight-icon.svg') {
    event.respondWith(
      fetch(request).then((response) => {
        if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()))
        return response
      }).catch(async () => (await caches.match(request)) || Response.error())
    )
  }
})

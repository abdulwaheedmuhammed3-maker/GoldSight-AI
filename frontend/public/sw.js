const CACHE_NAME = 'goldsight-shell-v2'
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
        if (response.ok) {
          // Clone before returning the original response, and keep cache writes
          // inside the fetch event lifetime.
          const responseForCache = response.clone()
          event.waitUntil(
            caches.open(CACHE_NAME).then((cache) => cache.put(request, responseForCache))
          )
        }
        return response
      }).catch(async () => (await caches.match(request)) || Response.error())
    )
  }
})


self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { body: event.data?.text() || '' } }
  const title = data.title || 'GoldSight AI alert'
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'A new confirmed market setup is available.',
    icon: '/goldsight-icon.svg',
    badge: '/goldsight-icon.svg',
    tag: data.event_key || 'goldsight-alert',
    renotify: false,
    data: { url: data.url || '/' }
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin) && 'focus' in client) return client.focus()
    }
    return self.clients.openWindow ? self.clients.openWindow(target) : undefined
  }))
})

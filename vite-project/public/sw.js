const CACHE = 'opd-dashboard-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(['/','/index.html','/manifest.webmanifest']))
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.pathname.startsWith('/api/')) return

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).then((resp) => {
          const copy = resp.clone()
          caches.open(CACHE).then((cache) => cache.put(event.request, copy))
          return resp
        }).catch(() => cached)
      )
    })
  )
})

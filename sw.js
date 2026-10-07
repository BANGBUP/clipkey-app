// Offline cache for the app shell. Network first so updates show up immediately.
// scripts/build-site.sh stamps CACHE per deploy, so every release installs a new worker.
const CACHE = 'clipkey-1.0.10-cca77dc'
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icon.svg',
  'js/app.js',
  'js/keyboard.js',
  'js/vkeys.js',
  'js/setupcode.js',
  'js/ble.js',
  'js/auth.js',
  'js/sender.js',
  'js/protocol.js',
  'js/keymap.js',
  'js/hangul.js',
  'js/constants.js',
  'js/crypto.js',
  'js/usbmode.js',
  'js/pcpair.js',
  'js/hosts.js',
  'js/hostsui.js',
  'js/reconnect.js',
  'js/nickname.js',
  'js/target.js',
  'js/lists.js',
  'js/phrases.js',
  'js/log.js',
  'js/debug.js',
  'js/firmware.js',
  'js/fwui.js',
  'js/version.js',
]

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the HTTP cache, so a new worker never stores last deploy's files.
  const requests = SHELL.map((url) => new Request(url, { cache: 'reload' }))
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(requests)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

// Query strings never become cache keys: a share-target visit (./?text=…) carries the
// shared text, which must not be stored on the phone.
function cacheKey(request) {
  if (request.mode === 'navigate') return new URL('./', self.registration.scope).href
  const url = new URL(request.url)
  return url.origin + url.pathname
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.includes('/firmware/')) return // updates: network only
  const key = cacheKey(request)
  event.respondWith(
    // no-cache: revalidate with the server so one deploy's modules are never mixed with
    // the previous one's from the HTTP cache.
    fetch(request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(key, copy))
        }
        return res
      })
      .catch(() => caches.match(key)),
  )
})

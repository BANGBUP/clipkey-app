// Offline cache for the app shell. Network first so updates show up immediately.
const CACHE = 'clipkey-v4'
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icon.svg',
  'js/app.js',
  'js/live.js',
  'js/ble.js',
  'js/auth.js',
  'js/sender.js',
  'js/protocol.js',
  'js/keymap.js',
  'js/hangul.js',
  'js/diff.js',
  'js/constants.js',
  'js/crypto.js',
  'js/usbmode.js',
  'js/pcpair.js',
  'js/hosts.js',
  'js/hostsui.js',
  'js/reconnect.js',
  'js/nickname.js',
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(event.request, copy))
        return res
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  )
})

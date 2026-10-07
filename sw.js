// Offline cache for the app shell. Network first so updates show up immediately.
const CACHE = 'clipkey-v8'
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
  'js/target.js',
  'js/lists.js',
  'js/phrases.js',
  'js/log.js',
  'js/debug.js',
  'js/firmware.js',
  'js/fwui.js',
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
  if (new URL(event.request.url).pathname.includes('/firmware/')) return // updates: network only
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

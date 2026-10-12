// Keeps the phone screen on while text is being typed. With the screen off (or another
// app in front) the browser freezes the page, and the rest of a long text stops coming.
// The browser drops the lock whenever the page is hidden, so it is taken again on return.

/** @param {{ wakeLock?: { request(type: string): Promise<any> } }} nav */
export function createWakeLock(nav = globalThis.navigator, doc = globalThis.document) {
  let wanted = false
  let lock = null
  let pending = null

  async function acquire() {
    if (!wanted || lock || pending || !nav?.wakeLock || doc?.visibilityState === 'hidden') return
    pending = nav.wakeLock.request('screen').catch(() => null) // unsupported / refused: nothing to do
    const next = await pending
    pending = null
    if (!next) return
    if (!wanted) {
      next.release?.().catch(() => undefined)
      return
    }
    lock = next
    lock.addEventListener?.('release', () => (lock = null))
  }

  doc?.addEventListener?.('visibilitychange', () => {
    if (doc.visibilityState === 'visible') acquire()
  })

  return Object.freeze({
    /** true while something is being typed; repeated calls are cheap. */
    set(on) {
      wanted = Boolean(on)
      if (wanted) {
        acquire()
        return
      }
      const held = lock
      lock = null
      held?.release?.().catch(() => undefined)
    },
    get held() {
      return lock !== null
    },
  })
}

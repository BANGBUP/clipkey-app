// In-memory debug log (from app start). Shown in the debug panel when enabled in settings.
// Never log typed text: only lengths, ids and errors.

const pad = (n, w = 2) => String(n).padStart(w, '0')
const stamp = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`

export const describeError = (error) =>
  error && typeof error === 'object' ? `${error.name ?? 'Error'}: ${error.message ?? ''}` : String(error)

export function createLog({ limit = 300, now = () => new Date() } = {}) {
  let lines = []
  const listeners = new Set()

  return Object.freeze({
    add(message) {
      const line = `${stamp(now())} ${message}`
      lines = [...lines, line].slice(-limit)
      listeners.forEach((fn) => {
        try {
          fn(line)
        } catch {
          // a broken view must not stop logging
        }
      })
    },
    lines: () => lines,
    clear() {
      lines = []
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  })
}

/** The app-wide log. */
export const appLog = createLog()

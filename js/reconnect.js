// Background reconnect loop used when the BLE link drops unexpectedly.

/**
 * @param {{ connect: () => Promise<unknown>, onAttemptFailed?: () => void, delays?: number[],
 *           maxAttempts?: number, sleep?: (ms: number) => Promise<void> }} options
 */
export function createReconnector({
  connect,
  onAttemptFailed = () => {},
  delays = [1000, 2000, 3000, 5000, 10000],
  maxAttempts = 30,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let running = null
  let stopped = false

  async function loop() {
    for (let attempt = 0; attempt < maxAttempts && !stopped; attempt += 1) {
      await sleep(delays[Math.min(attempt, delays.length - 1)])
      if (stopped) break
      try {
        await connect()
        if (!stopped) return true
        onAttemptFailed() // stopped while connecting: don't keep a link the user gave up on
        return false
      } catch {
        onAttemptFailed() // drop a half-open link before the next try
      }
    }
    return false
  }

  return Object.freeze({
    /** @returns {Promise<boolean>} true once reconnected, false if stopped or given up */
    start() {
      if (!running) {
        stopped = false
        running = loop().finally(() => {
          running = null
        })
      }
      return running
    },
    stop() {
      stopped = true
    },
    get running() {
      return running !== null
    },
  })
}

// Turns text (or single keys) into KEYS frames and streams them through the client.

import { textToCharOps } from './keymap.js'
import { encodeKeyFrames, encodeCharFrames, encodeCancel } from './protocol.js'
import { hasAttError } from './ble.js'
import { ATT_ERROR } from './constants.js'

/**
 * @param {ReturnType<import('./ble.js').createClient>} client
 * @param {(p: { sent: number, total: number, active: boolean }) => void} onProgress
 */
export function createSender(client, onProgress) {
  // cancel() bumps the generation; every job queued before that becomes stale and is dropped.
  let generation = 0
  let active = false
  let stopReason = null // 'user' | 'device', for the job that ends because of it
  let chain = Promise.resolve()

  const plainFrames = (ops) => encodeKeyFrames(ops).map((frame) => ({ frame, items: (frame.length - 1) / 2, charEnd: 0 }))

  /**
   * @param {Array<{ frame: Uint8Array, items: number, charEnd: number }>} frames
   * @param {{ charsDone: number }} done updated as frames are acknowledged
   * @returns {Promise<boolean>} true when every frame was handed to the device
   */
  async function streamFrames(frames, jobGeneration, done) {
    const isCancelled = () => jobGeneration !== generation
    const total = frames.reduce((n, f) => n + f.items, 0)
    let sent = 0
    onProgress({ sent, total, active: true })
    try {
      for (const { frame, items, charEnd } of frames) {
        if (isCancelled()) return false
        try {
          await client.sendKeys(frame, isCancelled)
        } catch (error) {
          if (!hasAttError(error, ATT_ERROR.STOPPED)) throw error
          stopLocal() // the device refused: someone pressed its BOOT button
          return false
        }
        if (isCancelled()) return false
        sent += items
        done.charsDone = charEnd
        onProgress({ sent, total, active: true })
      }
      return true
    } finally {
      onProgress({ sent, total, active: false })
    }
  }

  // Jobs run strictly in order so texts and keys never interleave.
  // `chars` (texts only) lets a failed job say what never reached the device: `remaining`.
  function enqueue(frames, skipped, chars = null) {
    const jobGeneration = generation
    const items = frames.reduce((n, f) => n + f.items, 0)
    const run = chain.then(async () => {
      if (jobGeneration !== generation) return { skipped, items: 0, completed: false, stopReason }
      active = true
      stopReason = null
      const done = { charsDone: 0 }
      try {
        const completed = frames.length === 0 || (await streamFrames(frames, jobGeneration, done))
        return { skipped, items, completed, stopReason: completed ? null : stopReason }
      } catch (error) {
        // Lost link, call, screen off ...: keys already handed over are typed by the device
        // anyway, so the rest starts right after the last acknowledged frame.
        if (chars) error.remaining = chars.slice(done.charsDone).join('')
        throw error
      } finally {
        active = false
      }
    })
    chain = run.catch(() => undefined)
    return run
  }

  /**
   * @returns {Promise<{ skipped: number, items: number, completed: boolean }>}
   *   rejects with `error.remaining`: the text the device never got
   */
  function sendText(text) {
    const { chars, groups, skipped } = textToCharOps(text)
    return enqueue(encodeCharFrames(groups), skipped, chars)
  }

  function sendOps(ops) {
    return enqueue(plainFrames(ops), 0)
  }

  /** Sends one non-KEYS frame (e.g. 한/영) after everything queued before it. */
  function sendFrame(frame) {
    const jobGeneration = generation
    const run = chain.then(() => (jobGeneration === generation ? client.send(frame) : undefined))
    chain = run.catch(() => undefined)
    return run
  }

  async function cancel() {
    generation += 1
    stopReason = 'user'
    if (client.connected) await client.send(encodeCancel())
  }

  /** The device already stopped (BOOT button): drop what is left here without a frame. */
  function stopLocal() {
    generation += 1
    stopReason = 'device'
  }

  return Object.freeze({
    sendText,
    sendOps,
    sendFrame,
    cancel,
    stopLocal,
    get active() {
      return active
    },
    get generation() {
      return generation
    },
  })
}

// Turns text (or single keys) into KEYS frames and streams them through the client.

import { textToOps } from './keymap.js'
import { encodeKeyFrames, encodeCancel } from './protocol.js'

/**
 * @param {ReturnType<import('./ble.js').createClient>} client
 * @param {(p: { sent: number, total: number, active: boolean }) => void} onProgress
 */
export function createSender(client, onProgress) {
  // cancel() bumps the generation; every job queued before that becomes stale and is dropped.
  let generation = 0
  let active = false
  let chain = Promise.resolve()

  /** @returns {Promise<boolean>} true when every op was handed to the device */
  async function streamOps(ops, jobGeneration) {
    const isCancelled = () => jobGeneration !== generation
    const frames = encodeKeyFrames(ops)
    const total = ops.length
    let sent = 0
    onProgress({ sent, total, active: true })
    try {
      for (const frame of frames) {
        if (isCancelled()) return false
        await client.sendKeys(frame, isCancelled)
        if (isCancelled()) return false
        sent += (frame.length - 1) / 2
        onProgress({ sent, total, active: true })
      }
      return true
    } finally {
      onProgress({ sent, total, active: false })
    }
  }

  // Jobs run strictly in order so texts and keys never interleave.
  function enqueue(ops, skipped) {
    const jobGeneration = generation
    const run = chain.then(async () => {
      if (jobGeneration !== generation) return { skipped, items: 0, completed: false }
      active = true
      try {
        const completed = ops.length === 0 || (await streamOps(ops, jobGeneration))
        return { skipped, items: ops.length, completed }
      } finally {
        active = false
      }
    })
    chain = run.catch(() => undefined)
    return run
  }

  /** @returns {Promise<{ skipped: number, items: number, completed: boolean }>} */
  function sendText(text) {
    const { ops, skipped } = textToOps(text)
    return enqueue(ops, skipped)
  }

  function sendOps(ops) {
    return enqueue(ops, 0)
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
    if (client.connected) await client.send(encodeCancel())
  }

  return Object.freeze({
    sendText,
    sendOps,
    sendFrame,
    cancel,
    get active() {
      return active
    },
    get generation() {
      return generation
    },
  })
}

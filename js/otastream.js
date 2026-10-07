// Fast OTA upload: DATA chunks go out back to back (writes without response) and the device
// reports its position every 4 KB (SECURE_MSG.OTA_PROGRESS). At most `windowBytes` may be
// unconfirmed; a chunk that went missing (device says "resend from") or a long silence
// rewinds to the device's position. Ordered writes mean the device never skips data.

export const OTA_PROGRESS = Object.freeze({ OK: 0, RESEND: 1, FAILED: 2 })

/** The very first streamed write was refused (e.g. a smaller MTU): nothing reached the device. */
export class StreamUnsupportedError extends Error {}

/**
 * @param {{
 *   total: number, chunkSize: number, windowBytes: number, stallMs: number, maxStalls: number,
 *   sendChunk: (offset: number, length: number) => Promise<void>,
 *   onProgress: (confirmed: number) => void, isCancelled: () => boolean,
 * }} opts
 */
export function createOtaStream({ total, chunkSize, windowBytes, stallMs, maxStalls, sendChunk, onProgress, isCancelled }) {
  let confirmed = 0 // bytes the device has written
  let next = 0 // next offset to send
  let failed = null
  let wake = null
  let rewoundTo = -1 // last "resend from" position acted on
  let rewoundAt = 0

  const notify = () => {
    const w = wake
    wake = null
    w?.()
  }

  function onNote({ status, written }) {
    if (status === OTA_PROGRESS.FAILED) {
      failed = new Error('기기에서 펌웨어 쓰기 실패')
    } else if (status === OTA_PROGRESS.RESEND) {
      // Every chunk still in flight after a gap misses too: act on a position once (the
      // device repeats it only if the resend got lost as well).
      const repeat = written === rewoundTo && Date.now() - rewoundAt < stallMs
      if (!repeat && written >= confirmed) {
        confirmed = written
        next = written
        rewoundTo = written
        rewoundAt = Date.now()
      }
    } else if (written > confirmed) {
      confirmed = written
      next = Math.max(next, written)
    }
    onProgress(confirmed)
    notify()
  }

  // Resolves on the next note, or false after `ms` of silence.
  const waitForNote = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null
        resolve(false)
      }, ms)
      wake = () => {
        clearTimeout(timer)
        resolve(true)
      }
    })

  async function run() {
    let lastProgressAt = Date.now()
    let lastConfirmed = 0
    while (confirmed < total) {
      if (failed) throw failed
      if (isCancelled()) throw new Error('취소했습니다')
      if (confirmed > lastConfirmed) {
        lastConfirmed = confirmed
        lastProgressAt = Date.now()
      } else if (Date.now() - lastProgressAt > stallMs * maxStalls) {
        // Notes may keep coming ("resend from") without the device ever moving on.
        throw new Error('기기 응답이 없어 업데이트를 멈췄습니다')
      }
      if (next < total && next - confirmed < windowBytes) {
        const length = Math.min(chunkSize, total - next)
        const offset = next
        next += length
        try {
          await sendChunk(offset, length)
        } catch (error) {
          if (offset === 0 && confirmed === 0) throw new StreamUnsupportedError(error?.message)
          throw error
        }
        continue
      }
      if (await waitForNote(stallMs)) continue
      // Silence: the progress note (or the chunks) got lost. Resend from the last
      // confirmed point; if the device is further along it answers with "resend from".
      next = confirmed
    }
    if (failed) throw failed
  }

  return Object.freeze({ run, onNote })
}

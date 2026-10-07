// Device events for the debug log (SECURE_MSG.DEVICE_EVENT): live ones, and the ones the
// ClipKey kept while this phone was away (sent again after it signs in).

import { SECURE_MSG, DEVICE_EVENT } from './constants.js'

const HEADER_LEN = 10
const SEEN_MAX = 300 // (boot, seq) keys remembered for dropping repeats

/** [0x09, flags, boot u16, seq u16, uptime_s u32, text...] */
export function parseDeviceEvent(bytes) {
  if (bytes.length < HEADER_LEN) throw new Error('기기 로그 길이 오류')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    type: SECURE_MSG.DEVICE_EVENT,
    replayed: (bytes[1] & DEVICE_EVENT.REPLAYED) !== 0,
    earlierBoot: (bytes[1] & DEVICE_EVENT.EARLIER_BOOT) !== 0,
    boot: view.getUint16(2, true),
    seq: view.getUint16(4, true),
    uptime: view.getUint32(6, true),
    text: new TextDecoder().decode(bytes.slice(HEADER_LEN)),
  }
}

/** Seconds since the device started: "45초", "12분 3초", "2시간 5분". */
export function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}초`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}분 ${seconds % 60}초`
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`
}

/** One debug-log line. Replayed events say they happened earlier, and when (device uptime). */
export function formatDeviceEvent(event) {
  const when = `기기 켜진 지 ${formatUptime(event.uptime)}`
  if (event.earlierBoot) return `[dev 재시작 전 · ${when}] ${event.text}`
  if (event.replayed) return `[dev 지난 기록 · ${when}] ${event.text}`
  return `[dev] ${event.text}`
}

/**
 * Drops events already shown (a replay repeats everything the device kept). Returns a
 * filter function: true = new, show it.
 */
export function createEventFilter() {
  let seen = []
  return (event) => {
    const key = `${event.boot}:${event.seq}`
    if (seen.includes(key)) return false
    seen = [...seen, key].slice(-SEEN_MAX)
    return true
  }
}

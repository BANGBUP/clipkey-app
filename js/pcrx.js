// "PC에서 받기": text the PC sends through its keyboard LEDs, relayed by the ClipKey as
// SECURE PC_RX (progress) and PC_TEXT (UTF-8 chunks) messages. Pure parsing + reassembly.

import { SECURE_MSG } from './constants.js'
import { crc16, crc32 } from './crc.js'

export const PC_RX_STATE = Object.freeze({
  RECEIVING: 1, // the ClipKey is receiving from the PC (start, then about every 32 bytes)
  DONE: 2, // all PC_TEXT chunks were sent before this
  BAD: 3, // checksum or length wrong: dropped
  TIMEOUT: 4, // the PC stopped sending
})

export const PC_TEXT_MAX = 65535 // u16 length; the ClipKey takes 32 KB (ESP32-S3) or 4 KB (ESP32)

// First payload byte (text itself never starts with these control characters):
export const PAYLOAD = Object.freeze({
  DEFLATE_TEXT: 0x00, // [0x00, raw deflate of UTF-8 text]
  FILE: 0x01, // [0x01, flags (bit0 deflate), name length, name UTF-8, data]
  // One piece of a payload too big for one frame: the pieces' data joined in order is the
  // payload (0x00 / 0x01 / plain text). The id is the payload's checksum, so the same content
  // sent again (or resumed later) has the same id, and pieces of other sends never mix.
  PART: 0x02, // older scripts: [0x02, id u16 (CRC-16), index u16 (from 0), count u16, data]
  PART32: 0x04, // [0x04, id u32 (CRC-32), index u16, count u16, data]
  // Sent before the pieces: what they are, so the 중단된 받기 list can name it.
  INFO: 0x03, // [0x03, id u32, count u16, size u32 (original bytes), name length, name UTF-8]
  // The PC gave up a stopped send (트레이 '폐기'): drop its kept pieces.
  CANCEL: 0x05, // [0x05, id u32, count u16]
})

const PART_HEADER = 7
const PART32_HEADER = 9

const u16 = (bytes, at) => bytes[at] | (bytes[at + 1] << 8)
const u32 = (bytes, at) => (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0

/** [0x07, state, received u16 LE, total u16 LE] (+ BAD from newer firmware: the CRC bytes that arrived, u16 LE) */
export function parsePcRx(bytes) {
  if (bytes.length < 6) throw new Error('PC 수신 상태 길이 오류')
  const msg = { type: SECURE_MSG.PC_RX, state: bytes[1], received: u16(bytes, 2), total: u16(bytes, 4) }
  return bytes.length >= 8 && bytes[1] === PC_RX_STATE.BAD ? { ...msg, rxCrc: u16(bytes, 6) } : msg
}

/** [0x08, offset u16 LE, total u16 LE, bytes 1..64] */
export function parsePcText(bytes) {
  if (bytes.length < 6) throw new Error('PC 텍스트 조각 길이 오류')
  return { type: SECURE_MSG.PC_TEXT, offset: u16(bytes, 1), total: u16(bytes, 3), data: bytes.slice(5) }
}

/**
 * Reassembly state: `buffer` is the text being collected ({ total, bytes, filled, broken }).
 * The ClipKey sends a finished text once: again only if no phone got it the first time, so
 * the same text arriving twice means the PC really sent it twice.
 */
export const EMPTY_RX = Object.freeze({ buffer: null })
const fail = (rx, reason) => ({ rx: { ...rx, buffer: null }, event: { type: 'failed', reason } })

function onText(rx, { offset, total, data }) {
  if (total === 0 || total > PC_TEXT_MAX) return { rx: { ...rx, buffer: null }, event: null }
  // Offset 0 always starts over: a new text, or the whole last one sent again.
  const buffer = offset === 0 ? { total, bytes: new Uint8Array(total), filled: 0, broken: false } : rx.buffer
  if (!buffer) return { rx, event: null } // middle of a text we never saw the start of
  const fits = buffer.total === total && offset === buffer.filled && offset + data.length <= total
  if (!fits) return { rx: { ...rx, buffer: { ...buffer, broken: true } }, event: null }
  const bytes = buffer.bytes.slice()
  bytes.set(data, offset)
  return { rx: { ...rx, buffer: { ...buffer, bytes, filled: offset + data.length } }, event: null }
}

function onDone(rx) {
  const buffer = rx.buffer
  if (!buffer) return { rx, event: null } // nothing collected (e.g. joined after the chunks)
  if (buffer.broken || buffer.filled !== buffer.total) return fail(rx, '일부가 빠졌습니다')
  const done = { rx: { buffer: null } }
  const bytes = buffer.bytes
  if (bytes[0] === PAYLOAD.PART || bytes[0] === PAYLOAD.PART32) {
    const part = parsePart(bytes)
    return part ? { ...done, event: { type: 'part', ...part } } : fail(rx, '조각 정보가 잘못되었습니다')
  }
  if (bytes[0] === PAYLOAD.INFO) {
    const info = parseInfo(bytes)
    return { ...done, event: info ? { type: 'info', ...info } : null } // just a label: a bad one is skipped
  }
  if (bytes[0] === PAYLOAD.CANCEL) {
    const cancel = bytes.length >= 7 ? { type: 'cancel', id: u32(bytes, 1), count: u16(bytes, 5), wide: true } : null
    return { ...done, event: cancel }
  }
  return { ...done, event: payloadEvent(bytes) }
}

/**
 * What a whole payload is: { type: 'done', compressed | text, size } | { type: 'file', ... } |
 * { type: 'failed', reason }.
 */
export function payloadEvent(bytes) {
  const size = bytes.length
  // 0x00 first: the script sent it deflate-compressed (shorter); inflateText() opens it.
  if (bytes[0] === PAYLOAD.DEFLATE_TEXT) return { type: 'done', compressed: bytes.subarray(1), size }
  if (bytes[0] === PAYLOAD.FILE) {
    const file = parseFilePayload(bytes)
    return file ? { type: 'file', ...file, size } : { type: 'failed', reason: '파일 정보가 잘못되었습니다' }
  }
  if (bytes[0] >= PAYLOAD.PART && bytes[0] <= PAYLOAD.CANCEL) return { type: 'failed', reason: '조각 정보가 잘못되었습니다' }
  return { type: 'done', text: new TextDecoder('utf-8', { fatal: false }).decode(bytes), size }
}

/** A piece (0x02 or 0x04) -> { id, index, count, wide, data } or null. */
export function parsePart(bytes) {
  const wide = bytes[0] === PAYLOAD.PART32
  if (!wide && bytes[0] !== PAYLOAD.PART) return null
  const header = wide ? PART32_HEADER : PART_HEADER
  if (bytes.length <= header) return null
  const id = wide ? u32(bytes, 1) : u16(bytes, 1)
  const at = wide ? 5 : 3
  const part = { id, index: u16(bytes, at), count: u16(bytes, at + 2), wide, data: bytes.slice(header) }
  return part.count >= 1 && part.index < part.count ? part : null
}

/** [0x03, id u32, count u16, size u32, name length, name] -> { id, count, wide, size, name } or null. */
export function parseInfo(bytes) {
  if (bytes.length < 12 || bytes[0] !== PAYLOAD.INFO) return null
  const nameEnd = 12 + bytes[11]
  if (nameEnd > bytes.length) return null
  const info = { id: u32(bytes, 1), count: u16(bytes, 5), wide: true, size: u32(bytes, 7) }
  const name = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(12, nameEnd))
  return info.count >= 1 ? { ...info, name } : null
}

export { crc16 } // tests and older callers

/** No pieces collected. */
export const EMPTY_PARTS = Object.freeze({ id: -1, count: 0, wide: false, pieces: Object.freeze([]) })

/** The same send: pieces of it belong together. */
export const sameSet = (a, b) => a.id === b.id && a.count === b.count && Boolean(a.wide) === Boolean(b.wide)

/**
 * Adds one piece. A different send starts a new collection. Returns
 * { parts, have, missing (1-based numbers before the newest piece), payload (when complete),
 *   mixed (complete but not the content the id names: dropped) }.
 */
export function addPart(parts, { id, index, count, wide = false, data }) {
  const pieces = sameSet(parts, { id, count, wide }) ? parts.pieces.slice() : new Array(count).fill(null)
  pieces[index] = data
  const next = { ...parts, id, count, wide, pieces }
  const have = pieces.filter(Boolean).length
  if (have === count) {
    const payload = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0))
    pieces.reduce((at, p) => (payload.set(p, at), at + p.length), 0)
    // The id is the payload's checksum: kept pieces of other content would join into garbage.
    if ((wide ? crc32(payload) : crc16(payload)) !== id) return { parts: EMPTY_PARTS, have, missing: [], payload: null, mixed: true }
    return { parts: EMPTY_PARTS, have, missing: [], payload }
  }
  const newest = pieces.reduce((last, p, i) => (p ? i : last), -1)
  const missing = pieces.slice(0, newest).flatMap((p, i) => (p ? [] : [i + 1]))
  return { parts: next, have, missing, payload: null }
}

/**
 * A frame failed while pieces were coming in: the piece numbers (1-based) to send again so
 * far. The damaged bytes usually still say which piece it was; otherwise it was the one after
 * the newest (pieces go out in order). [] when no split payload is involved.
 */
export function partsToResend(parts, damaged = null) {
  const hint = damaged ? parsePart(damaged) : null
  const ours = hint && parts.count > 0 && sameSet(hint, parts)
  // A new set (or none collected yet): only the broken piece itself is known.
  if (hint && !ours) return [hint.index + 1]
  if (parts.count === 0) return []
  const newest = parts.pieces.reduce((last, p, i) => (p ? i : last), -1)
  const failedAt = ours ? hint.index : newest + 1
  const upTo = Math.min(Math.max(newest, failedAt), parts.count - 1)
  return parts.pieces.slice(0, upTo + 1).flatMap((p, i) => (p ? [] : [i + 1]))
}

/** [0x01, flags, name length, name, data] -> { name, deflated, data } or null. */
export function parseFilePayload(bytes) {
  if (bytes.length < 3) return null
  const nameEnd = 3 + bytes[2]
  if (bytes[2] === 0 || nameEnd > bytes.length) return null
  const name = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(3, nameEnd))
  return { name, deflated: (bytes[1] & 1) !== 0, data: bytes.slice(nameEnd) }
}

/** Raw deflate -> bytes. */
export async function inflateBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Opens a compressed text (raw deflate of UTF-8). */
export async function inflateText(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(await inflateBytes(bytes))
}

/** The file's bytes as text, or null when they are not valid UTF-8 (a binary file). */
export function textOf(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes) // a leading BOM is dropped by the decoder
  } catch {
    return null
  }
}

/** Characters as a person counts them (an emoji or a 한글 syllable is one). */
export function charCount(text) {
  if (typeof Intl?.Segmenter === 'function') {
    let n = 0
    for (const _ of new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(text)) n += 1
    return n
  }
  return [...text].length
}

/**
 * Feeds one parsed PC_RX / PC_TEXT message. Returns the new state and what happened:
 * { type: 'progress', received, total, starting } | { type: 'done', text, size } |
 * { type: 'failed', reason } | null.
 */
export function reducePcRx(rx, msg) {
  if (msg.type === SECURE_MSG.PC_TEXT) return onText(rx, msg)
  if (msg.type !== SECURE_MSG.PC_RX) return { rx, event: null }
  switch (msg.state) {
    case PC_RX_STATE.RECEIVING: {
      // A fresh start drops whatever was half collected.
      const starting = msg.received === 0
      const next = starting ? { ...rx, buffer: null } : rx
      return { rx: next, event: { type: 'progress', received: msg.received, total: msg.total, starting } }
    }
    case PC_RX_STATE.DONE:
      return onDone(rx)
    case PC_RX_STATE.BAD: {
      // Newer firmware first sends what arrived, so it can be saved and compared.
      const b = rx.buffer
      const damaged = b && !b.broken && b.filled === b.total && b.total === msg.total ? b.bytes : null
      const out = fail(rx, '확인값이 맞지 않아 버렸습니다 (전송 중 깨짐)')
      const crc = msg.rxCrc === undefined ? {} : { rxCrc: msg.rxCrc } // to try a repair (pcrxrepair.js)
      return damaged ? { ...out, event: { ...out.event, damaged, ...crc } } : out
    }
    case PC_RX_STATE.TIMEOUT: {
      const out = fail(rx, 'PC 전송이 멈춰 중단했습니다')
      return { ...out, event: { ...out.event, stopped: true } }
    }
    default:
      return { rx, event: null }
  }
}

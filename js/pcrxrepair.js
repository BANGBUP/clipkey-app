// Repairing a PC -> phone frame whose CRC failed. Over Bluetooth the LED reports sometimes
// bounce: the clock (Scroll Lock) is seen once or twice too often, so a symbol is counted
// twice (received 3,3,2,2 where 3,2 was sent). Everything after shifts, and the frame's last
// symbols are pushed into the CRC bytes. Removing the extra symbols and checking the CRC that
// arrived (newer firmware sends it with BAD) finds the frame that was sent. Pure.

import { PAYLOAD, parsePart, parseFilePayload, inflateBytes, textOf } from './pcrx.js'

const toSymbols = (bytes) => {
  const out = new Uint8Array(bytes.length * 4)
  bytes.forEach((b, i) => {
    for (let s = 0; s < 4; s++) out[i * 4 + s] = (b >> (2 * s)) & 3
  })
  return out
}

const CRC_TABLE = (() => {
  const table = new Uint16Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i << 8
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff
    table[i] = c
  }
  return table
})()
const crcStep = (crc, byte) => ((crc << 8) & 0xffff) ^ CRC_TABLE[((crc >> 8) ^ byte) & 0xff]

/**
 * Where the extra clock edges may be (lists of symbol positions to remove): one symbol
 * repeated (a,a), or a bounce repeating two in a row (a,a,b,b -> a,b). Position 0 too (the
 * length's last symbol repeated into the payload), and the CRC bytes themselves.
 */
export function extraSymbolGuesses(symbols) {
  const guesses = [[0], [0, 1]]
  for (let k = 1; k < symbols.length; k++) {
    if (symbols[k] !== symbols[k - 1]) continue
    guesses.push([k])
    if (k + 2 < symbols.length && symbols[k + 1] === symbols[k + 2]) guesses.push([k, k + 1])
  }
  return guesses
}

/**
 * Candidate payloads for a damaged frame: each one, with the extra symbols removed, matches
 * the part of the CRC that is still there. Usually one; none when the damage is something
 * else; sometimes a chance match too (the caller checks further).
 * The CRC of the unchanged front is computed once; each guess only redoes the shifted rest.
 * @returns {{ payload: Uint8Array, removed: number[] }[]}
 */
export function repairCandidates(damaged, rxCrc) {
  const n = damaged.length
  if (n === 0 || n > 4096 || !Number.isInteger(rxCrc)) return []
  const symbols = toSymbols(Uint8Array.from([...damaged, rxCrc & 0xff, rxCrc >> 8]))
  // prefix[i]: CRC after the length bytes and payload bytes 0..i-1
  const prefix = new Uint16Array(n + 1)
  prefix[0] = crcStep(crcStep(0xffff, n & 0xff), n >> 8)
  for (let i = 0; i < n; i++) prefix[i + 1] = crcStep(prefix[i], damaged[i])
  const total = symbols.length // n*4 + 8
  const found = []
  const seen = new Set()
  for (const removed of extraSymbolGuesses(symbols)) {
    const first = removed[0]
    const skip = removed.length
    // symbol j of the repaired stream (j >= first) is received symbol j + skip; past the end: unknown
    const at = (j) => (j < first ? symbols[j] : j + skip < total ? symbols[j + skip] : 0)
    const startByte = Math.min(Math.floor(first / 4), n)
    let crc = prefix[startByte]
    const tail = new Uint8Array(n - startByte)
    for (let i = startByte; i < n; i++) {
      const j = i * 4
      const byte = at(j) | (at(j + 1) << 2) | (at(j + 2) << 4) | (at(j + 3) << 6)
      tail[i - startByte] = byte
      crc = crcStep(crc, byte)
    }
    let got = 0
    for (let s = 0; s < 8; s++) got |= at(n * 4 + s) << (2 * s)
    const mask = (1 << (2 * (8 - skip))) - 1 // the last `skip` CRC symbols were pushed out
    if ((crc & mask) !== (got & mask)) continue
    const payload = new Uint8Array(n)
    payload.set(damaged.subarray(0, startByte))
    payload.set(tail, startByte)
    const key = payload.join(',')
    if (seen.has(key)) continue
    seen.add(key)
    found.push({ payload, removed })
  }
  return found
}

/**
 * The repair to use, or null. Pieces may keep several candidates (a chance CRC match is not
 * rare): `alternatives` are all of them, and the send's CRC-32 picks the right one when it is
 * joined. Anything else must be the only candidate that makes sense (a compressed text must
 * open). Info and cancel frames are never repaired (the next piece names the send anyway).
 * @param {{ payload: Uint8Array, removed: number[] }[]} candidates
 * @param {(part: object) => boolean} knownSend
 * @returns {Promise<{ payload: Uint8Array, removed: number[], alternatives: Uint8Array[] } | null>}
 */
export async function pickRepair(candidates, knownSend) {
  const fits = []
  for (const candidate of candidates) {
    if (await plausible(candidate.payload, knownSend)) fits.push(candidate)
  }
  if (!fits.length) return null
  const pieces = fits.map((c) => parsePart(c.payload))
  if (pieces.every(Boolean)) {
    const [first] = pieces
    const samePiece = pieces.every((p) => p.id === first.id && p.count === first.count && p.index === first.index && p.wide === first.wide)
    return samePiece ? { ...fits[0], alternatives: fits.map((c) => c.payload) } : null
  }
  return fits.length === 1 ? { ...fits[0], alternatives: [fits[0].payload] } : null
}

async function plausible(payload, knownSend) {
  const kind = payload[0]
  if (kind === PAYLOAD.PART || kind === PAYLOAD.PART32) {
    const part = parsePart(payload)
    return part !== null && knownSend(part)
  }
  if (kind === PAYLOAD.DEFLATE_TEXT) return opensAsText(payload.subarray(1))
  if (kind === PAYLOAD.FILE) {
    const file = parseFilePayload(payload)
    return Boolean(file?.deflated) && (await opens(file.data)) // a raw file has nothing to check
  }
  if (kind === PAYLOAD.CANCEL || kind === PAYLOAD.INFO) return false // nothing lost by dropping them
  return textOf(payload) !== null
}

async function opens(bytes) {
  try {
    await inflateBytes(bytes)
    return true
  } catch {
    return false
  }
}

async function opensAsText(bytes) {
  try {
    return textOf(await inflateBytes(bytes)) !== null
  } catch {
    return false
  }
}

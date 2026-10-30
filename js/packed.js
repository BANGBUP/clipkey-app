// "트레이로 압축 보내기": a text or a file, deflated, typed as base64 into the PC tray's receive
// window (scripts/windows/clipkey-recv.ps1), which checks it and restores the text or file.
//
// Typed: [CK1.<base64 length>.<base64 of payload + CRC-32 LE>]
// Payload: the same as PC -> phone (pcrx.js PAYLOAD): plain UTF-8 text, 0x00 + deflate text,
// or 0x01, flags (bit0 deflate), name length, name, data.

import { PAYLOAD } from './pcrx.js'

export const PACK_PREFIX = '[CK1.'
export const PACK_END = ']'
const NAME_MAX = 200

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

/** CRC-32 (IEEE, as in zip). */
export function crc32(bytes) {
  let crc = 0xffffffff
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0)
  return out
}

/** Raw deflate. */
export async function deflateBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Plain UTF-8, or 0x00 + deflate when shorter (or when the text starts with a marker byte). */
export async function textPayload(text) {
  const raw = new TextEncoder().encode(text)
  const packed = await deflateBytes(raw)
  return packed.length + 1 < raw.length || raw[0] <= PAYLOAD.PART ? concat([PAYLOAD.DEFLATE_TEXT], packed) : raw
}

/** 0x01 file payload; the data is deflated when that is shorter. */
export async function filePayload(name, bytes) {
  const encoder = new TextEncoder()
  let nameBytes = encoder.encode(name)
  if (nameBytes.length > NAME_MAX || nameBytes.length === 0) {
    const ext = /\.[A-Za-z0-9]{1,10}$/.exec(name)?.[0] ?? ''
    nameBytes = encoder.encode(`file${ext}`)
  }
  const packed = await deflateBytes(bytes)
  const deflated = packed.length < bytes.length
  return concat([PAYLOAD.FILE, deflated ? 1 : 0, nameBytes.length], nameBytes, deflated ? packed : bytes)
}

function toBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

const withCrc = (payload) => {
  const crc = crc32(payload)
  return concat(payload, [crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24])
}

/** What the ClipKey types for a payload. */
export function packText(payload) {
  const body = toBase64(withCrc(payload))
  return `${PACK_PREFIX}${body.length}.${body}${PACK_END}`
}

// ---- chords (firmware CAPS.CHORD): 6 keys per report ----
// [ck2.<bytes>.<chords>]: the header and ] are typed as usual, the body as ITEM.CHORD keys.
// Each group of 6 has no key twice and none of the previous group's keys (the PC only sees
// newly pressed keys). A 5-bit value picks the n-th key still allowed, in CHORD_CHARS order;
// at least 43 - 6 - 5 = 32 are always left. Only unshifted keys: Caps Lock just changes the
// letters' case, which the receiver ignores.
export const CHORD_PREFIX = '[ck2.'
export const CHORD_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-=;',./"
export const CHORD_GROUP = 6
export const CHORD_HID = [
  ...Array.from({ length: 26 }, (_, i) => 0x04 + i),
  0x27, // 0
  ...Array.from({ length: 9 }, (_, i) => 0x1e + i), // 1-9
  0x2d, 0x2e, 0x33, 0x34, 0x36, 0x37, 0x38, // - = ; ' , . /
]
const BITS = 5

/** Body characters for `bytes` (5 bits each, high bits first). */
export function chordChars(bytes) {
  const values = []
  let acc = 0
  let nbits = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    nbits += 8
    while (nbits >= BITS) {
      nbits -= BITS
      values.push((acc >> nbits) & 31)
    }
    acc &= (1 << nbits) - 1
  }
  if (nbits > 0) values.push((acc << (BITS - nbits)) & 31)
  let prev = ''
  let group = ''
  let out = ''
  values.forEach((v, i) => {
    if (i % CHORD_GROUP === 0) [prev, group] = [group, '']
    const ch = [...CHORD_CHARS].filter((c) => !prev.includes(c) && !group.includes(c))[v]
    group += ch
    out += ch
  })
  return out
}

/** { header, keys (HID codes for ITEM.CHORD), end, chars (all typed characters) }. */
export function packChords(payload) {
  const bytes = withCrc(payload)
  const body = chordChars(bytes)
  const header = `${CHORD_PREFIX}${bytes.length}.`
  const keys = [...body].map((c) => CHORD_HID[CHORD_CHARS.indexOf(c)])
  return { header, keys, end: PACK_END, chars: header.length + body.length + PACK_END.length }
}

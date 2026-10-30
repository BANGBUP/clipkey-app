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

/** What the ClipKey types for a payload. */
export function packText(payload) {
  const crc = crc32(payload)
  const body = toBase64(concat(payload, [crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24]))
  return `${PACK_PREFIX}${body.length}.${body}${PACK_END}`
}

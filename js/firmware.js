// Firmware update over BLE: .ckfw parsing and OTA frames (see firmware/src/ota.h).

import { FRAME } from './constants.js'

export const OTA_HEADER_LEN = 132
// 200 bytes of data + 5 frame bytes + 20 bytes of encryption fit one 247-byte MTU write.
export const OTA_CHUNK = 200

const CHIPS = ['esp32', 'esp32s3']
export const chipName = (id) => CHIPS[id] ?? `chip${id}`

/** @returns {{ header: Uint8Array, image: Uint8Array, chip: number, version: string }} */
export function parseCkfw(bytes) {
  if (bytes.length < OTA_HEADER_LEN) throw new Error('ClipKey 펌웨어 파일이 아닙니다 (너무 짧음)')
  const header = bytes.slice(0, OTA_HEADER_LEN)
  if (new TextDecoder().decode(header.slice(0, 4)) !== 'CKFW' || header[4] !== 1) {
    throw new Error('ClipKey 펌웨어 파일(.ckfw)이 아닙니다')
  }
  const size = new DataView(header.buffer, header.byteOffset, OTA_HEADER_LEN).getUint32(8, true)
  const image = bytes.slice(OTA_HEADER_LEN)
  if (image.length !== size) throw new Error('펌웨어 파일이 손상되었습니다 (크기 불일치)')
  const version = new TextDecoder().decode(header.slice(12, 36)).replace(/\0+$/, '')
  return { header, image, chip: header[5], version }
}

export const encodeOtaBegin = ({ header }) => Uint8Array.from([FRAME.OTA_BEGIN, ...header])

export function encodeOtaData(offset, chunk) {
  const out = new Uint8Array(5 + chunk.length)
  out[0] = FRAME.OTA_DATA
  new DataView(out.buffer).setUint32(1, offset, true)
  out.set(chunk, 5)
  return out
}

export const encodeOtaEnd = () => Uint8Array.of(FRAME.OTA_END)
export const encodeOtaAbort = () => Uint8Array.of(FRAME.OTA_ABORT)

/** Numeric dotted compare; anything with a suffix ("-dev") sorts before the plain version. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, suffix] = String(v).split('-')
    return { nums: core.split('.').map((n) => Number(n) || 0), dev: Boolean(suffix) }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  return x.dev === y.dev ? 0 : x.dev ? -1 : 1
}

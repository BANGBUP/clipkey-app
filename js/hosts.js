// Paired PC / tablet list: encrypted device -> phone messages and host commands.

import { FRAME, SECURE_MSG, HOST_PROFILE, TARGET } from './constants.js'

const ADDR_LEN = 6
const HOST_HEADER = 1 + 1 + 1 + ADDR_LEN + 1 + 1 + 1 // type, index, addr type, addr, profile, flags, name len

const FLAG = Object.freeze({ CONNECTED: 1 << 0, DETECTED: 1 << 1, ACTIVE: 1 << 2 })

function parseHost(bytes) {
  if (bytes.length < HOST_HEADER) throw new Error(`기기 목록 항목 길이 오류: ${bytes.length}`)
  const nameLen = bytes[HOST_HEADER - 1]
  if (bytes.length < HOST_HEADER + nameLen) throw new Error('기기 이름 길이 오류')
  const flags = bytes[3 + ADDR_LEN + 1]
  // Alias follows the name (newer firmware); older firmware stops after the name.
  const aliasAt = HOST_HEADER + nameLen
  const aliasLen = bytes.length > aliasAt ? bytes[aliasAt] : 0
  if (aliasLen > 0 && bytes.length < aliasAt + 1 + aliasLen) throw new Error('기기 별명 길이 오류')
  const alias = new TextDecoder().decode(bytes.slice(aliasAt + 1, aliasAt + 1 + aliasLen))
  return {
    type: SECURE_MSG.HOST,
    index: bytes[1],
    host: Object.freeze({
      addr: { type: bytes[2], bytes: bytes.slice(3, 3 + ADDR_LEN) },
      profile: bytes[3 + ADDR_LEN],
      connected: (flags & FLAG.CONNECTED) !== 0,
      detected: (flags & FLAG.DETECTED) !== 0,
      active: (flags & FLAG.ACTIVE) !== 0,
      name: new TextDecoder().decode(bytes.slice(HOST_HEADER, HOST_HEADER + nameLen)),
      alias,
    }),
  }
}

/** @param {Uint8Array} bytes decrypted SECURE message */
export function parseSecureMessage(bytes) {
  switch (bytes[0]) {
    case SECURE_MSG.HOST:
      return parseHost(bytes)
    case SECURE_MSG.HOSTS_END:
      if (bytes.length < 2) throw new Error('목록 끝 표시 길이 오류')
      return { type: SECURE_MSG.HOSTS_END, total: bytes[1] }
    case SECURE_MSG.DEVICE_INFO: {
      const len = bytes[1] ?? 0
      if (bytes.length < 2 + len) throw new Error('기기 정보 길이 오류')
      const decode = (from, n) => new TextDecoder().decode(bytes.slice(from, from + n))
      // Newer firmware appends version and chip (older: nickname only).
      const verAt = 2 + len
      const verLen = bytes.length > verAt ? bytes[verAt] : 0
      const chipAt = verAt + 1 + verLen
      return {
        type: SECURE_MSG.DEVICE_INFO,
        nickname: decode(2, len),
        version: decode(verAt + 1, verLen),
        chip: bytes.length > chipAt ? bytes[chipAt] : null,
      }
    }
    case SECURE_MSG.OTA_RESULT:
      if (bytes.length < 3) throw new Error('업데이트 결과 길이 오류')
      return { type: SECURE_MSG.OTA_RESULT, phase: bytes[1], result: bytes[2] }
    case SECURE_MSG.PAIR_PROMPT: {
      if (bytes.length < 6) throw new Error('페어링 요청 길이 오류')
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      return { type: SECURE_MSG.PAIR_PROMPT, state: bytes[1], passkey: view.getUint32(2, true) }
    }
    default:
      throw new Error(`알 수 없는 보안 메시지: ${bytes[0]}`)
  }
}

const addrBytes = ({ type, bytes }) => [type, ...bytes]

export const encodeListHosts = () => Uint8Array.of(FRAME.LIST_HOSTS)
export const encodeDeleteHost = (addr) => Uint8Array.from([FRAME.DELETE_HOST, ...addrBytes(addr)])

export function encodeSetHostProfile(addr, profile) {
  if (!Object.values(HOST_PROFILE).includes(profile)) throw new Error(`알 수 없는 기기 종류: ${profile}`)
  return Uint8Array.from([FRAME.SET_HOST_PROFILE, ...addrBytes(addr), profile])
}

/** NimBLE stores addresses little-endian; people read them most significant byte first. */
export const formatHostAddr = ({ bytes }) =>
  [...bytes].reverse().map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':')

export const sameAddr = (a, b) => a.type === b.type && a.bytes.every((v, i) => v === b.bytes[i])

export const NICKNAME_MAX_BYTES = 30

/** The ClipKey's own nickname (e.g. "회사 PC"), stored on the device. */
export function encodeSetNickname(nickname) {
  const bytes = new TextEncoder().encode(String(nickname ?? '').trim())
  if (bytes.length > NICKNAME_MAX_BYTES) throw new Error(`별명이 너무 깁니다 (최대 ${NICKNAME_MAX_BYTES}바이트, 한글 약 10자)`)
  return Uint8Array.from([FRAME.SET_NICKNAME, ...bytes])
}

/** User label for a paired PC / tablet (e.g. "회사 노트북"). */
export function encodeSetHostAlias(addr, alias) {
  const bytes = new TextEncoder().encode(String(alias ?? '').trim())
  if (bytes.length > NICKNAME_MAX_BYTES) throw new Error(`별명이 너무 깁니다 (최대 ${NICKNAME_MAX_BYTES}바이트, 한글 약 10자)`)
  return Uint8Array.from([FRAME.SET_HOST_ALIAS, ...addrBytes(addr), ...bytes])
}

/** What to call a paired host: the user's alias, else its own name, else its address. */
export const hostTitle = (host) => host.alias || host.name || formatHostAddr(host.addr)

/** Choose which connected PC receives keystrokes. */
export function encodeSelectTarget({ kind, addr }) {
  if (kind === TARGET.BLE && !addr) throw new Error('블루투스 PC 주소가 필요합니다')
  const bytes = kind === TARGET.BLE ? addrBytes(addr) : [0, 0, 0, 0, 0, 0, 0]
  return Uint8Array.from([FRAME.SELECT_TARGET, kind, ...bytes])
}

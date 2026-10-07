// Binary encoding of frames sent to / received from the firmware.

import { OP, ITEM, FRAME, AUTH_FRAME, STATUS_FLAG, KEEP_AWAKE, KEEP_AWAKE_KEYS, USB_MODE, PAIR_ACTION, CAPS, HOST_LED, REGISTER_DEFAULT_CODE } from './constants.js'

export const MAX_ITEMS_PER_FRAME = 90 // 1 + 90*2 = 181 bytes, fits one long write comfortably

export function opToItem(op) {
  switch (op.type) {
    case OP.TAP:
      return [op.mod & 0x7f, op.key & 0xff]
    case OP.MODE:
      return [ITEM.MODE, op.hangul ? 1 : 0]
    case OP.COMMIT:
      return [ITEM.COMMIT, 0]
    default:
      throw new Error(`알 수 없는 op: ${JSON.stringify(op)}`)
  }
}

/** Splits ops into KEYS frames of at most MAX_ITEMS_PER_FRAME items. */
export function encodeKeyFrames(ops, maxItems = MAX_ITEMS_PER_FRAME) {
  const frames = []
  for (let i = 0; i < ops.length; i += maxItems) {
    const chunk = ops.slice(i, i + maxItems)
    frames.push(Uint8Array.from([FRAME.KEYS, ...chunk.flatMap(opToItem)]))
  }
  return frames
}

export const encodeSetIme = (hangul) => Uint8Array.of(FRAME.SET_IME, hangul ? 1 : 0)
export const encodeCancel = () => Uint8Array.of(FRAME.CANCEL)
export const encodeToggleIme = () => Uint8Array.of(FRAME.TOGGLE_IME)
export const encodeSetToggleKey = ({ mod, key }) => Uint8Array.of(FRAME.SET_TOGGLE_KEY, mod, key)

const clampDelay = (ms) => Math.max(2, Math.min(100, Math.round(ms)))

/** Key interval for Windows-style hosts and for iPad / Mac hosts. */
export function encodeSetDelay(ms, appleMs) {
  return Uint8Array.of(FRAME.SET_DELAY, clampDelay(ms), clampDelay(appleMs))
}

/** 0 seconds turns keep-awake off; otherwise the idle interval. `tap` is the key to press. */
export function encodeSetKeepAwake(seconds, { mod, key }) {
  const s = seconds <= 0 ? 0 : Math.max(KEEP_AWAKE.MIN_S, Math.min(KEEP_AWAKE.MAX_S, Math.round(seconds)))
  return Uint8Array.of(FRAME.SET_KEEP_AWAKE, s & 0xff, s >> 8, mod & 0x7f, key & 0xff)
}

/** Finds the KEEP_AWAKE_KEYS id matching the device's configured key, or null. */
export function keepAwakeKeyId({ keepAwakeMod, keepAwakeKey }) {
  const match = Object.entries(KEEP_AWAKE_KEYS).find(([, k]) => k.mod === keepAwakeMod && k.key === keepAwakeKey)
  return match ? match[0] : null
}

export function encodeSetUsbMode(mode) {
  if (mode !== USB_MODE.DEVICE && mode !== USB_MODE.HOST) throw new Error(`알 수 없는 USB 모드: ${mode}`)
  return Uint8Array.of(FRAME.SET_USB_MODE, mode)
}

export const encodePcPairing = (open) => Uint8Array.of(FRAME.PC_PAIRING, open ? 1 : 0)

export function encodePcPairReply({ accept, passkey = 0 }) {
  if (!Number.isInteger(passkey) || passkey < 0 || passkey > 999999) throw new Error('PIN은 6자리 숫자입니다')
  const out = new Uint8Array(6)
  const view = new DataView(out.buffer)
  view.setUint8(0, FRAME.PC_PAIR_REPLY)
  view.setUint8(1, accept ? 1 : 0)
  view.setUint32(2, passkey, true)
  return out
}

export const formatPasskey = (n) => String(n).padStart(6, '0')

export function encodeSetImeSettle(ms) {
  const v = Math.max(0, Math.min(1000, Math.round(ms)))
  return Uint8Array.of(FRAME.SET_IME_SETTLE, v & 0xff, v >> 8)
}

/** New phone setup code (4-12 digits) for this ClipKey. */
export function encodeSetSetupCode(code) {
  if (!/^\d{4,12}$/.test(code)) throw new Error('설정 코드는 숫자 4~12자리입니다')
  if (code === REGISTER_DEFAULT_CODE) throw new Error(`${REGISTER_DEFAULT_CODE}은 설정 코드로 쓸 수 없습니다`)
  return Uint8Array.from([FRAME.SET_SETUP_CODE, ...new TextEncoder().encode(code)])
}

export function encodeProve(hmac) {
  if (hmac.length !== 32) throw new Error('HMAC 길이는 32바이트여야 합니다')
  return Uint8Array.from([AUTH_FRAME.PROVE, ...hmac])
}

/** [0x02][phone pubkey x65][iv x12][AES-GCM(token) + tag x32] */
export function encodeRegister({ phonePub, iv, sealed }) {
  if (phonePub.length !== 65 || iv.length !== 12 || sealed.length !== 32) {
    throw new Error('등록 프레임 구성 오류')
  }
  return Uint8Array.from([AUTH_FRAME.REGISTER, ...phonePub, ...iv, ...sealed])
}

/** AUTH read: [nonce x16][device pubkey x65] (older firmware: nonce only outside pairing). */
export function parseAuthRead(view) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  if (bytes.length !== 16 && bytes.length !== 16 + 65) throw new Error(`AUTH 응답 길이 오류: ${bytes.length}`)
  return {
    nonce: bytes.slice(0, 16),
    devicePub: bytes.length > 16 ? bytes.slice(16) : null,
  }
}

/**
 * Status layout (little endian): [flags u8][queue_free u16][queue_used u16][keep_awake_s u16][mod u8][key u8]
 *                                [pair_action u8][0 u32 (PIN is sent encrypted)][caps u8][host profile u8][active PC conn u8]
 *                                [target kind u8][host LEDs u8]
 * An unauthenticated read is all zeros except the caps byte.
 * @param {DataView} view
 */
export function parseStatus(view) {
  if (view.byteLength < 5) throw new Error(`상태 패킷 길이 오류: ${view.byteLength}`)
  const flags = view.getUint8(0)
  const has = (bit) => (flags & bit) !== 0
  return Object.freeze({
    authed: has(STATUS_FLAG.AUTHED),
    pcConnected: has(STATUS_FLAG.PC_CONNECTED),
    imeHangul: has(STATUS_FLAG.IME_HANGUL),
    capsLock: has(STATUS_FLAG.CAPS_LOCK),
    pairingOpen: has(STATUS_FLAG.PAIRING_OPEN),
    usbKeyboard: has(STATUS_FLAG.USB_KEYBOARD),
    usbPc: has(STATUS_FLAG.USB_PC),
    hostMode: has(STATUS_FLAG.HOST_MODE),
    queueFree: view.getUint16(1, true),
    queueUsed: view.getUint16(3, true),
    keepAwakeSeconds: view.byteLength >= 7 ? view.getUint16(5, true) : 0,
    keepAwakeMod: view.byteLength >= 9 ? view.getUint8(7) : KEEP_AWAKE_KEYS.f15.mod,
    keepAwakeKey: view.byteLength >= 9 ? view.getUint8(8) : KEEP_AWAKE_KEYS.f15.key,
    pairAction: view.byteLength >= 14 ? view.getUint8(9) : PAIR_ACTION.NONE,
    passkey: view.byteLength >= 14 ? view.getUint32(10, true) : 0,
    usbOtg: view.byteLength >= 15 ? (view.getUint8(14) & CAPS.USB_OTG) !== 0 : true,
    noSetupCode: view.byteLength >= 15 && (view.getUint8(14) & CAPS.NO_SETUP_CODE) !== 0,
    regWindow: view.byteLength >= 15 && (view.getUint8(14) & CAPS.REG_WINDOW) !== 0,
    // Firmware with the 19-byte status registers phones with the BOOT button; older firmware
    // used a first-phone-only default code instead.
    bootRegistration: view.byteLength >= 19,
    hostProfile: view.byteLength >= 16 ? view.getUint8(15) : 0,
    activeConn: view.byteLength >= 17 && view.getUint8(16) !== 0xff ? view.getUint8(16) : null,
    targetKind: view.byteLength >= 18 ? view.getUint8(17) : null, // 0 none, 1 wired, 2 Bluetooth
    // Older firmware has no LED byte: undefined hides the Num / Scroll Lock chips.
    numLock: view.byteLength >= 19 ? (view.getUint8(18) & HOST_LED.NUM_LOCK) !== 0 : undefined,
    scrollLock: view.byteLength >= 19 ? (view.getUint8(18) & HOST_LED.SCROLL_LOCK) !== 0 : undefined,
  })
}

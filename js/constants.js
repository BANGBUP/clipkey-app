// Shared protocol constants. Must match firmware/src/protocol.h.

export const UUID = Object.freeze({
  SERVICE: '7a0c0001-5b6e-4b8e-9f2a-c11bce0de001',
  CMD: '7a0c0002-5b6e-4b8e-9f2a-c11bce0de001',
  STATUS: '7a0c0003-5b6e-4b8e-9f2a-c11bce0de001',
  AUTH: '7a0c0004-5b6e-4b8e-9f2a-c11bce0de001',
  SECURE: '7a0c0005-5b6e-4b8e-9f2a-c11bce0de001', // notify: AES-GCM sealed device -> phone messages
})

export const DEVICE_NAME = 'ClipKey' // devices advertise "ClipKey-XXXX" (end of their BT address)

export const ATT_ERROR = Object.freeze({
  QUEUE_FULL: 0x80,
  AUTH_FAILED: 0x82,
  LOCKED: 0x84,
  BUSY: 0x85, // still typing
  NO_SETUP_CODE: 0x86, // the device has no setup code yet (set it over USB)
  OTA_REJECTED: 0x87, // bad signature / wrong chip / bad hash
  OTA_OFFSET: 0x88,
  OTA_FAILED: 0x89,
})

// Logical operations produced by the text converter.
export const OP = Object.freeze({
  TAP: 'tap', // press + release one key with modifiers
  MODE: 'mode', // ensure PC IME is in hangul (true) / english (false) mode
  COMMIT: 'commit', // finish any in-progress hangul composition
})

// Wire encoding: every queue item is 2 bytes [a, b].
//   a = modifier bitmask (0x00-0x7F), b = HID keycode   -> tap
//   a = ITEM.MODE,   b = 0|1                            -> ensure IME mode
//   a = ITEM.COMMIT, b = 0                              -> commit composition
export const ITEM = Object.freeze({
  MODE: 0xf0,
  COMMIT: 0xf1,
})

export const FRAME = Object.freeze({
  KEYS: 0x10, // [0x10, item, item, ...]
  SET_IME: 0x11, // [0x11, 0|1]  resync firmware's belief, sends no keys
  CANCEL: 0x12, // [0x12]       drop queued items
  TOGGLE_IME: 0x13, // [0x13]     actually press the hangul/english key
  SET_TOGGLE_KEY: 0x14, // [0x14, mod, key]
  SET_DELAY: 0x15, // [0x15, ms]
  SET_KEEP_AWAKE: 0x16, // [0x16, seconds u16 LE, mod, key]  0 seconds = off
  SET_USB_MODE: 0x17, // [0x17, 0 device | 1 host]  saved, then the device reboots
  PC_PAIRING: 0x18, // [0x18, 1 open | 0 close]  Bluetooth PC pairing window (60 s, one PC)
  PC_PAIR_REPLY: 0x19, // [0x19, accept 0|1, passkey u32 LE]  answer to a pairing prompt
  LIST_HOSTS: 0x1a, // [0x1a]  device answers with SECURE HOST... HOSTS_END messages
  DELETE_HOST: 0x1b, // [0x1b, addr type, addr x6]  forget a paired PC / tablet
  SET_HOST_PROFILE: 0x1c, // [0x1c, addr type, addr x6, profile]
  SET_IME_SETTLE: 0x1d, // [0x1d, ms u16 LE]  wait after each 한/영 switch
  SET_NICKNAME: 0x1e, // [0x1e, utf8 x0..30]  shown in PC / tablet Bluetooth lists and the app
  SET_HOST_ALIAS: 0x1f, // [0x1f, addr type, addr x6, utf8 x0..30]  user label for a paired PC
  SELECT_TARGET: 0x20, // [0x20, kind, addr type, addr x6]  which connected PC gets keystrokes
  SET_SETUP_CODE: 0x21, // [0x21, ascii digits x4..12]
  OTA_BEGIN: 0x22, // [0x22, .ckfw header x132]
  OTA_DATA: 0x23, // [0x23, offset u32 LE, bytes...]
  OTA_END: 0x24, // [0x24] verify, activate, reboot
  OTA_ABORT: 0x25, // [0x25]
})

// Where keystrokes go (status byte 17 reports the link actually in use).
export const TARGET = Object.freeze({
  AUTO: 0, // wired PC if present, else the most recently connected Bluetooth PC
  USB: 1, // wired PC (ESP32-S3 only)
  BLE: 2, // one Bluetooth PC, by address
})

// Encrypted device -> phone messages on the SECURE characteristic.
export const SECURE_MSG = Object.freeze({
  PAIR_PROMPT: 0x01, // [0x01, state, passkey u32 LE]
  HOST: 0x02, // [0x02, index, addr type, addr x6, profile, flags, name len, name, alias len, alias]
  HOSTS_END: 0x03, // [0x03, total]
  DEVICE_INFO: 0x04, // [0x04, nick len, nick, version len, version, chip]
  OTA_RESULT: 0x05, // [0x05, phase 1 begin | 2 end, result 0 ok | 1 rejected | 2 failed]
})

// How a paired computer switches Korean / English (and its typing quirks).
export const HOST_PROFILE = Object.freeze({
  AUTO: 0, // use the app's default toggle key (non-Apple hosts stay here after detection)
  WINDOWS: 1, // 한/영 key, Caps Lock compensation
  WINDOWS_RALT: 2, // right Alt as 한/영
  APPLE: 3, // iPad / iPhone / Mac: Ctrl+Space, slower typing
})

export const HOST_PROFILE_LABEL = Object.freeze({
  [HOST_PROFILE.AUTO]: '자동 (Windows 등)',
  [HOST_PROFILE.WINDOWS]: 'Windows (한/영 키)',
  [HOST_PROFILE.WINDOWS_RALT]: 'Windows (오른쪽 Alt)',
  [HOST_PROFILE.APPLE]: 'iPad / Mac (Ctrl+Space)',
})

// PC pairing prompt shown in the app (the device has no screen).
export const PAIR_ACTION = Object.freeze({
  NONE: 0,
  NUMCMP: 1, // PC and app show the same 6 digits: confirm they match
  DISPLAY: 2, // app shows 6 digits: type them on the PC
  INPUT: 3, // PC shows 6 digits: type them in the app
  DONE: 4, // last pairing succeeded
  FAILED: 5, // last pairing failed or was rejected
  REJECTED_CLOSED: 6, // a PC / tablet tried to pair while the window was closed
})

// What the ESP32-S3 USB-OTG port does.
export const USB_MODE = Object.freeze({
  DEVICE: 0, // plugged into the PC: acts as a wired USB keyboard (default)
  HOST: 1, // a physical USB keyboard is plugged in and passed through
})

export const KEEP_AWAKE = Object.freeze({ MIN_S: 10, MAX_S: 3600 })

// Keys that reset the Windows idle timer without doing anything visible.
export const KEEP_AWAKE_KEYS = Object.freeze({
  f15: { mod: 0, key: 0x6a, label: 'F15 (권장)' },
  f13: { mod: 0, key: 0x68, label: 'F13' },
  f14: { mod: 0, key: 0x69, label: 'F14' },
  f16: { mod: 0, key: 0x6b, label: 'F16' },
  f24: { mod: 0, key: 0x73, label: 'F24' },
  lshift: { mod: 0x02, key: 0, label: '왼쪽 Shift (F키가 무시되는 PC용)' },
  rshift: { mod: 0x20, key: 0, label: '오른쪽 Shift' },
})
export const DEFAULT_KEEP_AWAKE_KEY = 'f15'

export const AUTH_FRAME = Object.freeze({
  PROVE: 0x01, // [0x01, hmac_sha256(token, nonce) x32]
  REGISTER: 0x02, // [0x02, phonePub x65, iv x12, sealedToken x32]  key mixes in the setup code
})

export const STATUS_FLAG = Object.freeze({
  AUTHED: 1 << 0,
  PC_CONNECTED: 1 << 1,
  IME_HANGUL: 1 << 2,
  CAPS_LOCK: 1 << 3,
  PAIRING_OPEN: 1 << 4, // Bluetooth PC pairing window is open
  USB_KEYBOARD: 1 << 5,
  USB_PC: 1 << 6, // device mode and the PC has enumerated the wired keyboard
  HOST_MODE: 1 << 7,
})

// STATUS caps byte
export const CAPS = Object.freeze({
  USB_OTG: 1 << 0, // ESP32-S3: wired keyboard / USB host modes exist (original ESP32: Bluetooth only)
  NO_SETUP_CODE: 1 << 1, // phones cannot register until a setup code is set over USB
})

export const MOD = Object.freeze({
  LCTRL: 0x01,
  LSHIFT: 0x02,
  LALT: 0x04,
  LGUI: 0x08,
  RALT: 0x40,
})

export const KEY = Object.freeze({
  ENTER: 0x28,
  ESC: 0x29,
  BACKSPACE: 0x2a,
  TAB: 0x2b,
  SPACE: 0x2c,
  RIGHT: 0x4f,
  LEFT: 0x50,
  DOWN: 0x51,
  UP: 0x52,
  LANG1: 0x90, // Hangul/English toggle
})

// How the connected computer switches Korean / English input.
export const TOGGLE_KEYS = Object.freeze({
  lang1: { mod: 0, key: KEY.LANG1, label: 'Windows: 한/영 키' },
  ralt: { mod: MOD.RALT, key: 0, label: 'Windows: 오른쪽 Alt' },
  ctrlspace: { mod: MOD.LCTRL, key: KEY.SPACE, label: 'iPad / Mac: Ctrl+Space' },
})

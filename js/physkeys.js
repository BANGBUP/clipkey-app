// A physical keyboard on the phone (Bluetooth / USB OTG) while the 키보드 tab is open:
// every key goes to the PC as the same key (event.code = position, so the phone's layout
// and IME don't matter). A modifier pressed and released alone is sent too (Win → Start,
// right Alt → 한/영 on Windows); with another key it only modifies that key.

const LETTER_A = 0x04
const F1 = 0x3a
const F13 = 0x68
const NUMPAD_1 = 0x59

const NAMED = Object.freeze({
  Digit0: 0x27, Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c,
  Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31, IntlHash: 0x32,
  Semicolon: 0x33, Quote: 0x34, Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38,
  CapsLock: 0x39, PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48, Insert: 0x49, Home: 0x4a,
  PageUp: 0x4b, Delete: 0x4c, End: 0x4d, PageDown: 0x4e,
  ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
  NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55, NumpadSubtract: 0x56, NumpadAdd: 0x57,
  NumpadEnter: 0x58, Numpad0: 0x62, NumpadDecimal: 0x63, IntlBackslash: 0x64, ContextMenu: 0x65,
  NumpadEqual: 0x67, IntlRo: 0x87, IntlYen: 0x89, Lang2: 0x91,
})

export const MODIFIER_BITS = Object.freeze({
  ControlLeft: 0x01, ShiftLeft: 0x02, AltLeft: 0x04, MetaLeft: 0x08,
  ControlRight: 0x10, ShiftRight: 0x20, AltRight: 0x40, MetaRight: 0x80,
})

// The 한/영 key: sent as the PC's own 한/영 switch (한/영 key, right Alt or Ctrl+Space).
export const IME_CODES = Object.freeze(['Lang1', 'HangulMode'])

/** HID usage of a KeyboardEvent.code, or 0 when the key has none. */
export function hidForCode(code) {
  let m = /^Key([A-Z])$/.exec(code)
  if (m) return LETTER_A + m[1].charCodeAt(0) - 0x41
  m = /^Digit([1-9])$/.exec(code)
  if (m) return 0x1e + Number(m[1]) - 1
  m = /^Numpad([1-9])$/.exec(code)
  if (m) return NUMPAD_1 + Number(m[1]) - 1
  m = /^F(\d{1,2})$/.exec(code)
  if (m) {
    const n = Number(m[1])
    if (n >= 1 && n <= 12) return F1 + n - 1
    if (n >= 13 && n <= 24) return F13 + n - 13
    return 0
  }
  return NAMED[code] ?? 0
}

/**
 * Tracks held modifiers and turns key events into what to send.
 * keydown → { tap: { mod, key } } | { ime: true } | { tap: null } (handled, nothing to send) | null (not ours)
 */
export function createPhysicalKeys() {
  let held = 0 // modifier bits down right now
  let usedWhileHeld = false // a key went out with the held modifiers

  function down({ code, repeat }) {
    const bit = MODIFIER_BITS[code]
    if (bit) {
      held |= bit
      return { tap: null }
    }
    if (IME_CODES.includes(code)) return repeat ? { tap: null } : { ime: true }
    const key = hidForCode(code)
    if (!key) return null
    if (held) usedWhileHeld = true
    return { tap: { mod: held, key } }
  }

  function up({ code }) {
    const bit = MODIFIER_BITS[code]
    if (!bit || !(held & bit)) return null
    const alone = !usedWhileHeld
    const mod = held
    usedWhileHeld = true // Ctrl+Shift released one by one goes out once
    held &= ~bit
    if (!held) usedWhileHeld = false
    return alone ? { tap: { mod, key: 0 } } : { tap: null }
  }

  function reset() {
    held = 0
    usedWhileHeld = false
  }

  return Object.freeze({ down, up, reset })
}

const MAX_KEYS = 6 // a boot keyboard report holds six keys

/**
 * Held-key state for firmware that takes it (CAPS.KEY_STATE): every press / release gives the
 * new { mod, keys } to send, or null when nothing changed (repeats, a 7th key, unknown keys).
 */
export function createKeyState() {
  let mod = 0
  let keys = []
  const state = () => ({ mod, keys: [...keys] })

  function down({ code, repeat }) {
    if (repeat) return null
    const bit = MODIFIER_BITS[code]
    if (bit) {
      if (mod & bit) return null
      mod |= bit
      return state()
    }
    const key = hidForCode(code)
    if (!key || keys.includes(key) || keys.length >= MAX_KEYS) return null
    keys = [...keys, key]
    return state()
  }

  function up({ code }) {
    const bit = MODIFIER_BITS[code]
    if (bit) {
      if (!(mod & bit)) return null
      mod &= ~bit
      return state()
    }
    const key = hidForCode(code)
    if (!keys.includes(key)) return null
    keys = keys.filter((k) => k !== key)
    return state()
  }

  /** A key this keyboard passes on (so the page should not act on it). */
  const knows = ({ code }) => Boolean(MODIFIER_BITS[code] || hidForCode(code))

  /** Lets go of everything; the release to send, or null when nothing was held. */
  function reset() {
    if (!mod && !keys.length) return null
    mod = 0
    keys = []
    return state()
  }

  return Object.freeze({ down, up, reset, knows })
}

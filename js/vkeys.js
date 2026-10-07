// On-screen extended keyboard: key table and sticky-modifier logic (no DOM, unit tested).
// Keys are raw HID usages on a US layout; in 한글 mode the PC IME composes them itself.

import { MOD } from './constants.js'

export const HID = Object.freeze({
  ENTER: 0x28,
  ESC: 0x29,
  BACKSPACE: 0x2a,
  TAB: 0x2b,
  SPACE: 0x2c,
  CAPS_LOCK: 0x39,
  F1: 0x3a,
  PRINT_SCREEN: 0x46,
  SCROLL_LOCK: 0x47,
  PAUSE: 0x48,
  INSERT: 0x49,
  HOME: 0x4a,
  PAGE_UP: 0x4b,
  DELETE: 0x4c,
  END: 0x4d,
  PAGE_DOWN: 0x4e,
  RIGHT: 0x4f,
  LEFT: 0x50,
  DOWN: 0x51,
  UP: 0x52,
  NUM_LOCK: 0x53,
  MENU: 0x65,
})

const LETTER_A = 0x04
const NON_SHIFT_MODS = MOD.LCTRL | MOD.LALT | MOD.LGUI

// Printable keys of the main block: [id, label, shifted label, 2-beolsik jamo]
const CHAR_KEYS = [
  ['`', '`', '~'], ['1', '1', '!'], ['2', '2', '@'], ['3', '3', '#'], ['4', '4', '$'], ['5', '5', '%'],
  ['6', '6', '^'], ['7', '7', '&'], ['8', '8', '*'], ['9', '9', '('], ['0', '0', ')'], ['-', '-', '_'],
  ['=', '=', '+'], ['[', '[', '{'], [']', ']', '}'], ['\\', '\\', '|'], [';', ';', ':'], ["'", "'", '"'],
  [',', ',', '<'], ['.', '.', '>'], ['/', '/', '?'],
]
const CHAR_CODES = Object.freeze({
  '`': 0x35, '1': 0x1e, '2': 0x1f, '3': 0x20, '4': 0x21, '5': 0x22, '6': 0x23, '7': 0x24, '8': 0x25,
  '9': 0x26, '0': 0x27, '-': 0x2d, '=': 0x2e, '[': 0x2f, ']': 0x30, '\\': 0x31, ';': 0x33, "'": 0x34,
  ',': 0x36, '.': 0x37, '/': 0x38,
})
const JAMO = Object.freeze({
  q: 'ㅂ', w: 'ㅈ', e: 'ㄷ', r: 'ㄱ', t: 'ㅅ', y: 'ㅛ', u: 'ㅕ', i: 'ㅑ', o: 'ㅐ', p: 'ㅔ',
  a: 'ㅁ', s: 'ㄴ', d: 'ㅇ', f: 'ㄹ', g: 'ㅎ', h: 'ㅗ', j: 'ㅓ', k: 'ㅏ', l: 'ㅣ',
  z: 'ㅋ', x: 'ㅌ', c: 'ㅊ', v: 'ㅍ', b: 'ㅠ', n: 'ㅜ', m: 'ㅡ',
})

function buildKeys() {
  const keys = {}
  for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
    keys[ch] = { code: LETTER_A + ch.charCodeAt(0) - 0x61, label: ch.toUpperCase(), sub: JAMO[ch], letter: true }
  }
  for (const [id, label, shifted] of CHAR_KEYS) keys[id] = { code: CHAR_CODES[id], label, sub: shifted }
  for (let n = 1; n <= 12; n += 1) keys[`f${n}`] = { code: HID.F1 + n - 1, label: `F${n}` }
  const named = {
    esc: [HID.ESC, 'Esc'], tab: [HID.TAB, 'Tab'], enter: [HID.ENTER, 'Enter'], backspace: [HID.BACKSPACE, '⌫'],
    space: [HID.SPACE, 'Space'], delete: [HID.DELETE, 'Del'], insert: [HID.INSERT, 'Ins'], home: [HID.HOME, 'Home'],
    end: [HID.END, 'End'], pageup: [HID.PAGE_UP, 'PgUp'], pagedown: [HID.PAGE_DOWN, 'PgDn'], up: [HID.UP, '↑'],
    down: [HID.DOWN, '↓'], left: [HID.LEFT, '←'], right: [HID.RIGHT, '→'], capslock: [HID.CAPS_LOCK, 'Caps'],
    printscreen: [HID.PRINT_SCREEN, 'PrtSc'], numlock: [HID.NUM_LOCK, 'NumLk'], scrolllock: [HID.SCROLL_LOCK, 'ScrLk'],
    pause: [HID.PAUSE, 'Pause'], menu: [HID.MENU, '메뉴'],
  }
  for (const [id, [code, label]] of Object.entries(named)) keys[id] = { code, label }
  return Object.freeze(keys)
}

/** Every single key the keyboard can send, by id. */
export const KEYS = buildKeys()

/** Sticky modifiers shown on the keyboard. */
export const MODIFIERS = Object.freeze([
  { id: 'ctrl', mod: MOD.LCTRL, label: 'Ctrl' },
  { id: 'shift', mod: MOD.LSHIFT, label: 'Shift' },
  { id: 'alt', mod: MOD.LALT, label: 'Alt' },
  { id: 'win', mod: MOD.LGUI, label: 'Win' },
])

/** One-tap shortcuts: [id, label, mod, key id or null for a bare modifier tap, Windows only]. */
export const SHORTCUTS = Object.freeze(
  [
    ['copy', '복사', MOD.LCTRL, 'c'],
    ['paste', '붙여넣기', MOD.LCTRL, 'v'],
    ['cut', '잘라내기', MOD.LCTRL, 'x'],
    ['undo', '실행 취소', MOD.LCTRL, 'z'],
    ['selectall', '전체 선택', MOD.LCTRL, 'a'],
    ['save', '저장', MOD.LCTRL, 's'],
    ['alttab', 'Alt+Tab', MOD.LALT, 'tab'],
    ['altf4', 'Alt+F4', MOD.LALT, 'f4', true],
    ['desktop', '바탕화면', MOD.LGUI, 'd', true],
    ['lock', 'PC 잠금', MOD.LGUI, 'l', true],
    ['start', '시작(Win)', MOD.LGUI, null, true],
    ['ctrlaltdel', 'Ctrl+Alt+Del', MOD.LCTRL | MOD.LALT, 'delete', true],
  ].map(([id, label, mod, key, windowsOnly = false]) => Object.freeze({ id, label, mod, key, windowsOnly })),
)

/** Rows of the main block (key ids). */
export const MAIN_ROWS = Object.freeze([
  ['`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']', '\\'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'"],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/'],
])

// ---- sticky modifiers ---------------------------------------------------
// armed: applies to the next key only. locked: stays until tapped again.

export const EMPTY_MODS = Object.freeze({ armed: 0, locked: 0 })

/** Tap on a modifier: off -> armed (next key) -> locked -> off. */
export function tapModifier(state, mod) {
  if (state.locked & mod) return { armed: state.armed & ~mod, locked: state.locked & ~mod }
  if (state.armed & mod) return { armed: state.armed & ~mod, locked: state.locked | mod }
  return { armed: state.armed | mod, locked: state.locked }
}

/** Modifiers for the key being sent now, and the state after it (armed ones are used up). */
export function consumeModifiers(state, extraMod = 0) {
  return { mod: state.armed | state.locked | extraMod, next: { armed: 0, locked: state.locked } }
}

export const modifierState = (state, mod) => (state.locked & mod ? 'locked' : state.armed & mod ? 'armed' : 'off')

/**
 * The (mod, key) item to queue for a key. While the PC's Caps Lock is on, the device turns
 * it off around typed letters (Windows-style hosts) so text comes out as written; flipping
 * Shift keeps the on-screen keyboard behaving like a real one with Caps Lock on. Not in
 * 한글 mode: there Shift would change the jamo (ㄱ -> ㄲ) while Caps Lock changes nothing.
 */
export function keyItem(keyId, mod, { capsLock = false, hangul = false, apple = false } = {}) {
  const key = KEYS[keyId]
  if (!key) throw new Error(`알 수 없는 키: ${keyId}`)
  const flipShift = key.letter && capsLock && !hangul && !apple && (mod & NON_SHIFT_MODS) === 0
  return { mod: flipShift ? mod ^ MOD.LSHIFT : mod, key: key.code }
}

/** Item for a shortcut, with any extra armed modifiers merged in. */
export function shortcutItem(shortcut, extraMod = 0) {
  const mod = shortcut.mod | extraMod
  return shortcut.key === null ? { mod, key: 0 } : { mod, key: KEYS[shortcut.key].code }
}

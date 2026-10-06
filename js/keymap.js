// Converts text into logical keyboard ops for a Windows PC with the Korean IME
// and a US/Korean (103/106) key layout.

import { OP, KEY, MOD } from './constants.js'
import { isHangulSyllable, isCompatJamo, syllableToKeys, jamoToKeys } from './hangul.js'

const LETTER_A = 0x04
const UNSHIFTED_SYMBOLS = {
  '1': 0x1e, '2': 0x1f, '3': 0x20, '4': 0x21, '5': 0x22,
  '6': 0x23, '7': 0x24, '8': 0x25, '9': 0x26, '0': 0x27,
  ' ': KEY.SPACE, '-': 0x2d, '=': 0x2e, '[': 0x2f, ']': 0x30, '\\': 0x31,
  ';': 0x33, "'": 0x34, '`': 0x35, ',': 0x36, '.': 0x37, '/': 0x38,
  '\n': KEY.ENTER, '\t': KEY.TAB,
}
const SHIFTED_SYMBOLS = {
  '!': 0x1e, '@': 0x1f, '#': 0x20, '$': 0x21, '%': 0x22,
  '^': 0x23, '&': 0x24, '*': 0x25, '(': 0x26, ')': 0x27,
  '_': 0x2d, '+': 0x2e, '{': 0x2f, '}': 0x30, '|': 0x31,
  ':': 0x33, '"': 0x34, '~': 0x35, '<': 0x36, '>': 0x37, '?': 0x38,
}

const tap = (key, mod = 0) => ({ type: OP.TAP, key, mod })

// Text copied from web pages and documents is full of characters that look like keyboard
// characters but have no key (NBSP around formatted words, smart quotes, dashes ...).
// Map them to what a person would type. (NFKC is not used: it would also turn Hangul
// compatibility jamo into conjoining jamo.)
const UNICODE_SPACES = /[   -   　]/g
const ZERO_WIDTH = /[​-‍⁠﻿­]/g
const PUNCTUATION = Object.freeze({
  '‘': "'", '’': "'", '‚': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '″': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
  '…': '...', '․': '.', '•': '*', '·': '*',
})
const PUNCTUATION_CHARS = new RegExp(`[${Object.keys(PUNCTUATION).join('')}]`, 'g')
const FULL_WIDTH_ASCII = /[！-～]/g

export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .replace(ZERO_WIDTH, '')
    .replace(UNICODE_SPACES, ' ')
    .replace(FULL_WIDTH_ASCII, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(PUNCTUATION_CHARS, (ch) => PUNCTUATION[ch])
}

function letterTap(ch) {
  const lower = ch.toLowerCase()
  const key = LETTER_A + lower.charCodeAt(0) - 0x61
  return tap(key, ch === lower ? 0 : MOD.LSHIFT)
}

function keyStringToTaps(keys) {
  return [...keys].map(letterTap)
}

// Classifies one character. Returns { mode: true|false|null, ops, commitAround } or null.
function classify(ch) {
  if (/^[a-zA-Z]$/.test(ch)) return { mode: false, ops: [letterTap(ch)] }
  if (ch in UNSHIFTED_SYMBOLS) return { mode: null, ops: [tap(UNSHIFTED_SYMBOLS[ch])] }
  if (ch in SHIFTED_SYMBOLS) return { mode: null, ops: [tap(SHIFTED_SYMBOLS[ch], MOD.LSHIFT)] }

  const cp = ch.codePointAt(0)
  if (isHangulSyllable(cp)) return { mode: true, ops: keyStringToTaps(syllableToKeys(cp)) }
  if (isCompatJamo(cp)) {
    return { mode: true, ops: [{ type: OP.COMMIT }, ...keyStringToTaps(jamoToKeys(cp)), { type: OP.COMMIT }] }
  }
  return null
}

/**
 * @param {string} text
 * @returns {{ ops: Array<object>, skipped: number }}
 */
export function textToOps(text) {
  const normalized = normalizeText(text)
  const result = [...normalized].reduce(
    (acc, ch) => {
      const c = classify(ch)
      if (!c) return { ...acc, skipped: acc.skipped + 1 }
      const needsMode = c.mode !== null && c.mode !== acc.mode
      const modeOps = needsMode ? [{ type: OP.MODE, hangul: c.mode }] : []
      return {
        ops: [...acc.ops, ...modeOps, ...c.ops],
        mode: c.mode ?? acc.mode,
        skipped: acc.skipped,
      }
    },
    { ops: [], mode: null, skipped: 0 },
  )
  return { ops: result.ops, skipped: result.skipped }
}

/** Characters textToOps would skip, unique, as "U+XXXX" (for diagnosing odd input). */
export function unsupportedChars(text) {
  const seen = [...normalizeText(text)].filter((ch) => classify(ch) === null)
  return [...new Set(seen.map((ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`))]
}

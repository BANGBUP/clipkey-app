// Hangul -> 2-beolsik (Dubeolsik) key strings.
// Each key string uses lowercase letters for plain keys and uppercase for shifted keys.

const SYLLABLE_BASE = 0xac00
const SYLLABLE_LAST = 0xd7a3
const JAMO_BASE = 0x3131
const JAMO_LAST = 0x3163

const INITIALS = ['r', 'R', 's', 'e', 'E', 'f', 'a', 'q', 'Q', 't', 'T', 'd', 'w', 'W', 'c', 'z', 'x', 'v', 'g']

const MEDIALS = [
  'k', 'o', 'i', 'O', 'j', 'p', 'u', 'P', 'h', 'hk', 'ho',
  'hl', 'y', 'n', 'nj', 'np', 'nl', 'b', 'm', 'ml', 'l',
]

const FINALS = [
  '', 'r', 'R', 'rt', 's', 'sw', 'sg', 'e', 'f', 'fr', 'fa', 'fq', 'ft', 'fx',
  'fv', 'fg', 'a', 'q', 'qt', 't', 'T', 'd', 'w', 'c', 'z', 'x', 'v', 'g',
]

// Compatibility jamo U+3131..U+314E (consonants) followed by U+314F..U+3163 (vowels).
const COMPAT_CONSONANTS = [
  'r', 'R', 'rt', 's', 'sw', 'sg', 'e', 'E', 'f', 'fr', 'fa', 'fq', 'ft', 'fx', 'fv',
  'fg', 'a', 'q', 'Q', 'qt', 't', 'T', 'd', 'w', 'W', 'c', 'z', 'x', 'v', 'g',
]
const COMPAT_JAMO = [...COMPAT_CONSONANTS, ...MEDIALS]

export function isHangulSyllable(cp) {
  return cp >= SYLLABLE_BASE && cp <= SYLLABLE_LAST
}

export function isCompatJamo(cp) {
  return cp >= JAMO_BASE && cp <= JAMO_LAST
}

export function syllableToKeys(cp) {
  const index = cp - SYLLABLE_BASE
  const initial = Math.floor(index / (21 * 28))
  const medial = Math.floor((index % (21 * 28)) / 28)
  const final = index % 28
  return INITIALS[initial] + MEDIALS[medial] + FINALS[final]
}

export function jamoToKeys(cp) {
  return COMPAT_JAMO[cp - JAMO_BASE]
}

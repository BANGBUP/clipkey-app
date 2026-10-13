// "긴 글 숨 고르기": a long text slowly makes the PC app slower (Notepad redraws, spell
// checks ...). Typing faster than it keeps up breaks Hangul composition, so a long text
// gets a short rest every few hundred characters, and keys slowly space out as it grows.
// Both ride in the KEYS stream (ITEM.PAUSE / ITEM.PACE); older firmware ignores them.

import { OP } from './constants.js'

export const PACE_STEP_CHARS = 1000 // the key interval grows every this many characters
export const PACE_MAX_MS = 20 // ...by at most this much (the firmware caps it at 100)
const PAUSE_ITEM_MAX_MS = 2550 // one ITEM.PAUSE holds b x 10 ms

export const DEFAULT_PACING = Object.freeze({ every: 500, pauseMs: 1500, stepMs: 2 })

export const isPacingOff = ({ every, pauseMs, stepMs }) => (every <= 0 || pauseMs <= 0) && stepMs <= 0

/** Extra ms per key for the characters from `index` on. */
export function paceAt(index, stepMs) {
  return Math.min(PACE_MAX_MS, Math.floor(index / PACE_STEP_CHARS) * stepMs)
}

function pauseOps(ms) {
  const ops = []
  for (let left = ms; left > 0; left -= PAUSE_ITEM_MAX_MS) {
    ops.push({ type: OP.PAUSE, ms: Math.min(left, PAUSE_ITEM_MAX_MS) })
  }
  return ops
}

/**
 * Adds rests and slow-downs to the ops of each character (see textToCharOps). They go at
 * the end of a character's group, so a frame still never splits a character.
 * @param {Array<Array<object>>} groups
 * @param {{ every: number, pauseMs: number, stepMs: number }} pacing
 * @returns {Array<Array<object>>} new groups; the input is not changed
 */
export function addPacing(groups, pacing) {
  if (isPacingOff(pacing) || groups.length <= Math.min(pacing.every || Infinity, PACE_STEP_CHARS)) return groups
  const { every, pauseMs, stepMs } = pacing
  const last = groups.length - 1
  return groups.map((group, i) => {
    const done = i + 1 // characters typed after this group
    if (i === last) return group
    const extra = []
    if (stepMs > 0 && done % PACE_STEP_CHARS === 0) extra.push({ type: OP.PACE, ms: paceAt(done, stepMs) })
    if (every > 0 && pauseMs > 0 && done % every === 0) extra.push(...pauseOps(pauseMs))
    return extra.length > 0 ? [...group, ...extra] : group
  })
}

/**
 * Time the pacing adds to a text of `chars` characters with `taps` key taps (for the
 * estimate under the send box). Each tap is two reports, each followed by the extra wait.
 */
export function pacingExtraMs({ chars, taps }, pacing) {
  if (chars === 0 || isPacingOff(pacing)) return 0
  const { every, pauseMs, stepMs } = pacing
  const pauses = every > 0 && pauseMs > 0 ? Math.floor((chars - 1) / every) * pauseMs : 0
  if (stepMs <= 0) return pauses
  const tapsPerChar = taps / chars
  let paced = 0
  for (let from = PACE_STEP_CHARS; from < chars; from += PACE_STEP_CHARS) {
    const span = Math.min(PACE_STEP_CHARS, chars - from)
    paced += span * tapsPerChar * 2 * paceAt(from, stepMs)
  }
  return pauses + paced
}

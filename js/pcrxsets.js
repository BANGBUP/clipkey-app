// 중단된 받기: pieces of split PC sends kept per send (up to MAX_SETS), so a stopped send can
// wait while other things are sent, and be resumed later. Pure: no DOM, no storage.

import { addPart, sameSet, parseFilePayload, PAYLOAD } from './pcrx.js'

export const MAX_SETS = 5
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000

/** One kept send: { key, id, count, wide, name, size, at, pieces }. */
export const keyOf = ({ id, count, wide }) => `${wide ? 'w' : 'n'}${id.toString(16)}-${count}`

const newSet = ({ id, count, wide = false }, now) =>
  ({ key: keyOf({ id, count, wide }), id, count, wide: Boolean(wide), name: null, size: null, at: now, pieces: new Array(count).fill(null) })

export const findSet = (sets, ref) => sets.find((s) => sameSet(s, ref)) ?? null
export const haveOf = (set) => set.pieces.filter(Boolean).length

/** Every piece number (1-based) not yet received: what '이어 보내기' must still send. */
export const partsLeft = (set) => set.pieces.flatMap((p, i) => (p ? [] : [i + 1]))

/** [3, 5, 8, 9, 10] -> "3,5,8-10" (what clipkey-send.ps1 -Parts takes). */
export function formatParts(numbers) {
  const runs = []
  for (const n of numbers) {
    const last = runs[runs.length - 1]
    if (last && n === last[1] + 1) runs[runs.length - 1] = [last[0], n]
    else runs.push([n, n])
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : b === a + 1 ? `${a},${b}` : `${a}-${b}`)).join(',')
}

/** A name to show: from the PC's info frame, else the file header in piece 1 (older scripts). */
export function setName(set) {
  if (set.name) return set.name
  const first = set.pieces[0]
  if (first && first[0] === PAYLOAD.FILE) {
    const file = parseFilePayload(first)
    if (file) return file.name
  }
  return first ? '텍스트' : '이름 모름'
}

// Newest first; past MAX_SETS the longest untouched go.
function keep(sets, set) {
  const rest = sets.filter((s) => s.key !== set.key)
  const all = [set, ...rest]
  return { sets: all.slice(0, MAX_SETS), dropped: all.slice(MAX_SETS) }
}

/** The PC said what is coming: name the set (made now if new). */
export function noteInfo(sets, info, now) {
  const set = { ...(findSet(sets, info) ?? newSet(info, now)), name: info.name || null, size: info.size, at: now }
  return { ...keep(sets, set), set }
}

/**
 * Adds a piece to its own set. Returns { sets, set (null once joined), have, missing,
 * payload, mixed, dropped (sets pushed out) }.
 */
export function addPiece(sets, part, now) {
  const set = findSet(sets, part) ?? newSet(part, now)
  const result = addPart(set, part)
  if (result.payload || result.mixed) {
    return { ...result, sets: sets.filter((s) => s.key !== set.key), set: null, dropped: [] }
  }
  const next = { ...set, pieces: result.parts.pieces, at: now }
  return { ...result, ...keep(sets, next), set: next }
}

export const removeSet = (sets, key) => sets.filter((s) => s.key !== key)

/** Drops the oldest until `size(sets)` fits (the newest always stays). */
export function fitSets(sets, size, max) {
  let kept = sets
  while (kept.length > 1 && size(kept) > max) kept = kept.slice(0, -1)
  return { sets: kept, dropped: sets.slice(kept.length) }
}

const toBase64 = (bytes) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

/** JSON-safe copy for storage. */
export const storeSets = (sets) =>
  sets.map(({ id, count, wide, name, size, at, pieces }) => ({ id, count, wide, name, size, at, pieces: pieces.map((p) => (p ? toBase64(p) : null)) }))

function loadOne(saved, now) {
  const ok =
    saved && Number.isInteger(saved.id) && Number.isInteger(saved.count) && saved.count > 0 &&
    Array.isArray(saved.pieces) && saved.pieces.length === saved.count && Number.isFinite(saved.at) && now - saved.at < KEEP_MS
  if (!ok) return null
  const pieces = saved.pieces.map((p) => (typeof p === 'string' ? fromBase64(p) : null))
  const wide = saved.wide === true
  const name = typeof saved.name === 'string' ? saved.name : null
  const size = Number.isFinite(saved.size) ? saved.size : null
  return { key: keyOf({ id: saved.id, count: saved.count, wide }), id: saved.id, count: saved.count, wide, name, size, at: saved.at, pieces }
}

/** Back from storeSets: expired or malformed ones are left out. */
export function loadSets(saved, now) {
  if (!Array.isArray(saved)) return []
  return saved
    .map((one) => {
      try {
        return loadOne(one, now)
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .slice(0, MAX_SETS)
}

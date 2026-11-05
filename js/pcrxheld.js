// 받기 탭 '중단된 받기': the kept sets in localStorage and their list (name, pieces, delete).

import { storeSets, loadSets, fitSets, haveOf, partsLeft, formatParts, setName } from './pcrxsets.js'

const SETS_KEY = 'clipkey.pcrx.sets.v1'
const OLD_KEY = 'clipkey.pcrx.parts.v1' // 1.0.95: one set only
// localStorage holds about 5 MB of text; this leaves room for the rest of the app.
const MAX_CHARS = 3_000_000

/** The kept sets (the 1.0.95 single set is taken over once). */
export function readHeld(now = Date.now()) {
  try {
    const saved = JSON.parse(localStorage.getItem(SETS_KEY) ?? 'null')
    if (saved) return loadSets(saved, now)
    const old = JSON.parse(localStorage.getItem(OLD_KEY) ?? 'null')
    return old ? loadSets([old], now) : []
  } catch {
    return []
  }
}

/**
 * Saves the sets that fit (a send too big for storage stays in memory only, while the app is
 * open); returns { sets, dropped } where dropped are the oldest pushed out to make room.
 */
export function writeHeld(sets) {
  const size = (list) => JSON.stringify(storeSets(list)).length
  const storable = sets.filter((s) => size([s]) <= MAX_CHARS)
  const { sets: fit } = fitSets(storable, size, MAX_CHARS)
  const dropped = storable.filter((s) => !fit.includes(s))
  const kept = sets.filter((s) => !dropped.includes(s))
  try {
    localStorage.removeItem(OLD_KEY)
  } catch {
    // unavailable
  }
  // Storage refusing (full with other data): keep fewer, oldest out first, rather than none.
  for (let n = fit.length; n >= 0; n--) {
    try {
      if (n) localStorage.setItem(SETS_KEY, JSON.stringify(storeSets(fit.slice(0, n))))
      else localStorage.removeItem(SETS_KEY)
      break
    } catch {
      // try with one less
    }
  }
  return { sets: kept, dropped }
}

const when = (at) =>
  new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** One line per kept set. */
export function heldSummary(set) {
  const left = partsLeft(set)
  const leftText = left.length ? `남은 조각 ${formatParts(left)}` : ''
  // 1.0.95 scripts numbered pieces differently: the new ones cannot add to these.
  const old = set.wide ? '' : '예전 방식이라 이어받기 안 됨, 처음부터 다시 보내세요'
  return { name: setName(set), detail: [`${haveOf(set)}/${set.count}조각`, when(set.at), leftText, old].filter(Boolean).join(' · ') }
}

/**
 * @param {{ box: HTMLElement, list: HTMLElement, onDelete: (key: string) => void }} deps
 * @returns {(sets: object[]) => void} render
 */
export function setupHeldList({ box, list, onDelete }) {
  const row = (set) => {
    const { name, detail } = heldSummary(set)
    const title = Object.assign(document.createElement('strong'), { textContent: name })
    const hint = Object.assign(document.createElement('div'), { className: 'hint', textContent: detail })
    const text = document.createElement('div')
    text.className = 'grow'
    text.append(title, hint)
    const del = Object.assign(document.createElement('button'), { className: 'btn small danger', textContent: '삭제' })
    del.addEventListener('click', () => onDelete(set.key))
    const line = document.createElement('div')
    line.className = 'row held-row'
    line.append(text, del)
    return line
  }
  return (sets) => {
    box.classList.toggle('hidden', sets.length === 0)
    list.replaceChildren(...sets.map(row))
  }
}

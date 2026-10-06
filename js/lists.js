// Phone-local lists: recent texts (history) and saved phrases (snippets). Pure helpers
// return new arrays; persistence goes through createStore so it can be tested.

export const HISTORY_LIMIT = 20
const TITLE_FROM_TEXT = 18

/** Newest first, no duplicates, no blank entries, at most HISTORY_LIMIT. */
export function addToHistory(history, text, at = Date.now()) {
  if (!String(text ?? '').trim()) return history
  const rest = history.filter((e) => e.text !== text)
  return [{ text, at }, ...rest].slice(0, HISTORY_LIMIT)
}

export function removeFromHistory(history, text) {
  return history.filter((e) => e.text !== text)
}

const defaultId = () => crypto.randomUUID()

/** Adds a snippet, or replaces the one with the same id. */
export function upsertSnippet(list, { id, title, text }, makeId = defaultId) {
  const body = String(text ?? '')
  if (!body.trim()) throw new Error('보낼 내용을 입력하세요')
  const cleanTitle = String(title ?? '').trim()
  const oneLine = body.replace(/\s+/g, ' ').trim()
  const autoTitle = oneLine.length > TITLE_FROM_TEXT ? `${oneLine.slice(0, TITLE_FROM_TEXT)}…` : oneLine
  const snippet = Object.freeze({ id: id ?? makeId(), title: cleanTitle || autoTitle, text: body })
  return id && list.some((s) => s.id === id) ? list.map((s) => (s.id === id ? snippet : s)) : [...list, snippet]
}

export const removeSnippet = (list, id) => list.filter((s) => s.id !== id)

/** Moves a snippet up (-1) or down (+1). */
export function moveSnippet(list, id, delta) {
  const from = list.findIndex((s) => s.id === id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

const isString = (v) => typeof v === 'string'

/** Keeps only well-formed history entries (storage may hold anything). */
export const validHistory = (v) =>
  Array.isArray(v) ? v.filter((e) => e && isString(e.text)).map((e) => ({ text: e.text, at: Number(e.at) || 0 })) : []

/** Keeps only well-formed snippets. */
export const validSnippets = (v) =>
  Array.isArray(v)
    ? v.filter((s) => s && isString(s.id) && isString(s.title) && isString(s.text)).map(({ id, title, text }) => ({ id, title, text }))
    : []

/**
 * JSON in localStorage-like storage; never throws on load, reports failure on save.
 * `validate` turns whatever was stored into a safe value.
 */
export function createStore(storage, key, fallback, validate = (v) => v) {
  return Object.freeze({
    load() {
      try {
        const raw = storage.getItem(key)
        return raw === null ? fallback : validate(JSON.parse(raw))
      } catch {
        return fallback
      }
    },
    save(value) {
      try {
        storage.setItem(key, JSON.stringify(value))
        return true
      } catch {
        return false
      }
    },
  })
}

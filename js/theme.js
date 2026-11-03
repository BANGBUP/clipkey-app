// Light / dark look chosen in 설정. index.html applies the saved choice before first paint;
// until the user picks one, the phone's own dark-mode setting decides.

export const THEME_KEY = 'clipkey.theme'
export const THEMES = ['light', 'dark']
// Browser bar colour = header surface of each theme (keep in sync with styles.css).
export const THEME_BAR_COLOR = { light: '#ffffff', dark: '#111e2a' }

/** Saved choice if valid, otherwise the system preference. */
export function resolveTheme(saved, systemDark) {
  return THEMES.includes(saved) ? saved : systemDark ? 'dark' : 'light'
}

function readSaved(storage) {
  try {
    return storage.getItem(THEME_KEY)
  } catch {
    return null // storage blocked: fall back to the system preference
  }
}

export function applyTheme(theme, doc = document) {
  doc.documentElement.dataset.theme = theme
  const meta = doc.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', THEME_BAR_COLOR[theme])
}

/** Wire the 밝게/어둡게 radios in 설정. */
export function setupTheme({ storage = globalThis.localStorage, win = globalThis, doc = document } = {}) {
  const radios = [...doc.querySelectorAll('input[name="theme"]')]
  const systemQuery = win.matchMedia?.('(prefers-color-scheme: dark)')
  let sessionPick = null // survives even when storage refuses to save
  const current = () => resolveTheme(sessionPick ?? readSaved(storage), systemQuery?.matches === true)

  const show = (theme) => {
    applyTheme(theme, doc)
    radios.forEach((r) => { r.checked = r.value === theme })
  }
  show(current())

  radios.forEach((r) => r.addEventListener('change', () => {
    if (!r.checked || !THEMES.includes(r.value)) return
    sessionPick = r.value
    try {
      storage.setItem(THEME_KEY, r.value)
    } catch {
      // not saved; still switch for this session
    }
    show(r.value)
  }))

  // No choice saved yet: keep following the phone when it switches day/night.
  systemQuery?.addEventListener?.('change', () => {
    if (!sessionPick && !THEMES.includes(readSaved(storage))) show(current())
  })
}

// Typing settings: 한/영 method, key interval and 한/영 wait for Windows-style PCs and for
// iPad / Mac (a 2x2 table), and "긴 글 숨 고르기". Saved on the phone, pushed to the device.

import { TOGGLE_KEYS } from './constants.js'
import { encodeSetToggleKey, encodeSetDelay, encodeSetImeSettle } from './protocol.js'
import { DEFAULT_PACING } from './pacing.js'

const SETTINGS_KEY = 'clipkey.settings.v1'

export const DEFAULT_SETTINGS = Object.freeze({
  toggleKey: 'lang1',
  delay: 15,
  appleDelay: 20,
  packDelay: 8, // 트레이로 압축 보내기: only while that runs
  settle: 30,
  appleSettle: 30,
  breathEvery: DEFAULT_PACING.every,
  breathMs: DEFAULT_PACING.pauseMs,
  slowStepMs: DEFAULT_PACING.stepMs,
})

const inRange = (v, min, max) => Number.isFinite(v) && v >= min && v <= max
const LIMITS = Object.freeze({
  delay: [2, 40],
  appleDelay: [2, 40],
  packDelay: [2, 40],
  settle: [0, 500],
  appleSettle: [0, 500],
  breathEvery: [0, 5000],
  breathMs: [0, 10000],
  slowStepMs: [0, 10],
})

/** Anything stored (or typed) that is out of range falls back to the default. */
export function validateSettings(raw = {}) {
  const toggleKey = raw.toggleKey in TOGGLE_KEYS ? raw.toggleKey : DEFAULT_SETTINGS.toggleKey
  const numbers = Object.fromEntries(
    Object.entries(LIMITS).map(([name, [min, max]]) => [name, inRange(raw[name], min, max) ? raw[name] : DEFAULT_SETTINGS[name]]),
  )
  // Saved before the Apple 한/영 wait existed: start from the shared value.
  const appleSettle = inRange(raw.appleSettle, ...LIMITS.appleSettle) ? raw.appleSettle : numbers.settle
  return Object.freeze({ toggleKey, ...numbers, appleSettle })
}

export function loadSettings(storage = globalThis.localStorage) {
  try {
    return validateSettings(JSON.parse(storage.getItem(SETTINGS_KEY) ?? '{}'))
  } catch {
    return validateSettings()
  }
}

export function saveSettings(settings, storage = globalThis.localStorage) {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // storage unavailable: settings last for this session only
  }
}

export const pacingOf = (s) => ({ every: s.breathEvery, pauseMs: s.breathMs, stepMs: s.slowStepMs })

/**
 * Frames that hand the settings to the device. Firmware without CAPS.PACING knows only one
 * 한/영 wait (and refuses the longer frame), so it gets the Windows value.
 */
export function settingsFrames(settings, { pacing }) {
  return [
    encodeSetToggleKey(TOGGLE_KEYS[settings.toggleKey]),
    encodeSetDelay(settings.delay, settings.appleDelay),
    pacing ? encodeSetImeSettle(settings.settle, settings.appleSettle) : encodeSetImeSettle(settings.settle),
  ]
}

// Slider + its value label: shows while dragging, applies when let go.
function wireRange($, id, value, onChange) {
  const input = $(id)
  const out = $(`${id}Out`)
  input.value = value
  out.textContent = value
  input.addEventListener('input', () => (out.textContent = input.value))
  input.addEventListener('change', () => onChange(Number(input.value)))
}

// Number box; an out-of-range entry snaps back to the saved value.
function wireNumber($, id, scale, get, apply) {
  const input = $(id)
  const show = () => (input.value = get()[id] / scale)
  show()
  input.addEventListener('change', () => {
    const next = Math.round(Number(input.value) * scale)
    if (inRange(next, ...LIMITS[id])) apply({ [id]: next })
    show()
  })
}

/**
 * @param {{ $: (id: string) => HTMLElement, get: () => object, apply: (patch: object) => object }} deps
 *   apply saves a patch of valid values
 */
export function wireTypingSettings({ $, get, apply }) {
  const settings = get()
  const select = $('toggleKey')
  Object.entries(TOGGLE_KEYS).forEach(([value, { label }]) => select.add(new Option(label, value)))
  select.value = settings.toggleKey
  select.addEventListener('change', () => apply({ toggleKey: select.value }))

  for (const id of ['delay', 'appleDelay', 'packDelay', 'settle', 'appleSettle']) {
    wireRange($, id, settings[id], (v) => apply({ [id]: v }))
  }
  wireNumber($, 'breathEvery', 1, get, apply)
  wireNumber($, 'breathMs', 1000, get, apply)
  wireNumber($, 'slowStepMs', 1, get, apply)
}

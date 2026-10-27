// "키보드" tab: an extended on-screen keyboard (shortcuts, function / navigation keys, a
// QWERTY block) that sends each key to the PC as soon as it is tapped.

import { OP, MOD } from './constants.js'
import { errorText } from './log.js'
import { encodeToggleIme } from './protocol.js'
import {
  KEYS,
  MODIFIERS,
  SHORTCUTS,
  MAIN_ROWS,
  EMPTY_MODS,
  tapModifier,
  consumeModifiers,
  modifierState,
  keyItem,
  shortcutItem,
} from './vkeys.js'
import { createPhysicalKeys } from './physkeys.js'

const NAV_ROWS = [
  ['esc', 'tab', 'capslock', 'printscreen', 'insert', 'delete'],
  ['home', 'end', 'pageup', 'pagedown', 'numlock', 'scrolllock'],
  ['backspace', 'left', 'up', 'down', 'right', 'enter'],
]
const F_ROWS = [
  ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'],
  ['f7', 'f8', 'f9', 'f10', 'f11', 'f12'],
]
// Screen reader names for keys shown as symbols.
const SPOKEN = Object.freeze({
  backspace: '백스페이스', up: '위쪽 화살표', down: '아래쪽 화살표', left: '왼쪽 화살표', right: '오른쪽 화살표',
})
const ARIA_PRESSED = Object.freeze({ off: 'false', armed: 'mixed', locked: 'true' })

function button(className, dataset, label, sub) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = className
  Object.assign(el.dataset, dataset)
  el.textContent = label
  if (sub) {
    const small = document.createElement('small')
    small.textContent = sub
    el.append(small)
  }
  return el
}

function section(title, rows, className = 'vk-row') {
  const box = document.createElement('div')
  box.className = 'vk-section'
  if (title) {
    const h = document.createElement('div')
    h.className = 'hint'
    h.textContent = title
    box.append(h)
  }
  for (const row of rows) {
    const line = document.createElement('div')
    line.className = className
    line.append(...row)
    box.append(line)
  }
  return box
}

const keyButtons = (ids) =>
  ids.map((id) => {
    const el = button('key', { key: id }, KEYS[id].label, KEYS[id].sub)
    if (SPOKEN[id]) el.setAttribute('aria-label', SPOKEN[id])
    return el
  })

function render(root) {
  const mods = [
    ...MODIFIERS.map((m) => {
      const el = button('key mod', { mod: String(m.mod) }, m.label)
      el.setAttribute('aria-pressed', 'false')
      return el
    }),
    button('key', { ime: '1' }, '한/영'),
  ]
  const shortcuts = SHORTCUTS.map((s) => button('key small-label', { shortcut: s.id }, s.label))
  const space = button('key', { key: 'space' }, 'Space')
  space.classList.add('vk-space')
  root.setAttribute('role', 'group')
  root.setAttribute('aria-label', 'PC 키보드')
  root.replaceChildren(
    section('', [mods]),
    section('단축키', [shortcuts.slice(0, 6), shortcuts.slice(6)]),
    section('기능 키', [...NAV_ROWS, ...F_ROWS].map(keyButtons)),
    section('문자 키 (한글 모드면 PC가 한글로 조합)', [...MAIN_ROWS.map(keyButtons), [space, ...keyButtons(['backspace', 'enter'])]], 'vk-row vk-main'),
  )
}

/**
 * @param {{ root: HTMLElement, client, sender, notify: (msg: string) => void, isApple: () => boolean }} deps
 */
export function setupKeyboard({ root, client, sender, notify, isApple }) {
  let mods = EMPTY_MODS
  render(root)

  const paintModifiers = () =>
    root.querySelectorAll('[data-mod]').forEach((el) => {
      const state = modifierState(mods, Number(el.dataset.mod))
      el.classList.toggle('armed', state === 'armed')
      el.classList.toggle('locked', state === 'locked')
      el.setAttribute('aria-pressed', ARIA_PRESSED[state])
    })

  const report = (error) => notify(`전송 실패: ${errorText(error)}`)

  // Every key, 한/영 included, goes through the sender chain so taps arrive in order.
  let inFlight = 0 // taps sent but not yet taken by the device
  function send(item) {
    inFlight += 1
    sender
      .sendOps([{ type: OP.TAP, mod: item.mod, key: item.key }])
      .catch(report)
      .finally(() => {
        inFlight -= 1
      })
  }

  root.addEventListener('click', (event) => {
    const el = event.target.closest('button')
    if (!el || !root.contains(el)) return
    if (el.dataset.mod) {
      mods = tapModifier(mods, Number(el.dataset.mod))
      return paintModifiers()
    }
    if (!client.connected) return notify('먼저 기기에 연결하세요')
    if (el.dataset.ime) {
      sender.sendFrame(encodeToggleIme()).catch(report)
      return
    }
    const { mod, next } = consumeModifiers(mods)
    mods = next
    paintModifiers()
    if (el.dataset.shortcut) {
      send(shortcutItem(SHORTCUTS.find((s) => s.id === el.dataset.shortcut), mod))
    } else if (el.dataset.key) {
      const status = client.status
      const pc = { capsLock: Boolean(status?.capsLock), hangul: Boolean(status?.imeHangul), apple: isApple() }
      send(keyItem(el.dataset.key, mod, pc))
    }
  })

  // A physical keyboard on the phone: while this tab is open (and no text box has focus)
  // every key goes to the PC as is.
  const physical = createPhysicalKeys()
  const panel = root.closest('.panel')
  const listening = (event) => {
    const field = event.target?.closest?.('input, textarea, select, [contenteditable="true"]')
    return !field && panel?.classList.contains('active') && client.connected
  }

  document.addEventListener('keydown', (event) => {
    if (!listening(event)) return
    // A held key repeats faster than taps reach the PC: send the next repeat only once the
    // last tap is through, so typing stops when the key is let go instead of piling up.
    if (event.repeat && inFlight > 0) return event.preventDefault()
    const action = physical.down(event)
    if (!action) return
    event.preventDefault() // Tab, Space, Backspace ... act on the PC, not on this page
    if (action.ime) {
      sender.sendFrame(encodeToggleIme()).catch(report)
    } else if (action.tap) {
      const { mod, next } = consumeModifiers(mods) // on-screen Ctrl / Shift ... still apply
      mods = next
      paintModifiers()
      send({ mod: action.tap.mod | mod, key: action.tap.key })
    }
  })
  document.addEventListener('keyup', (event) => {
    if (!listening(event)) return
    const action = physical.up(event)
    if (!action) return
    event.preventDefault()
    if (action.tap) send(action.tap)
  })
  window.addEventListener('blur', () => physical.reset())

  return Object.freeze({
    setEnabled(enabled) {
      root.classList.toggle('disabled', !enabled)
      root.setAttribute('aria-disabled', String(!enabled))
      if (!enabled) {
        physical.reset()
        mods = EMPTY_MODS
        paintModifiers()
      }
    },
    /** iPad / Mac: the GUI modifier is ⌘, and Windows-only shortcuts are hidden. */
    setApple(apple) {
      root.querySelector(`[data-mod="${MOD.LGUI}"]`).textContent = apple ? '⌘' : 'Win'
      for (const s of SHORTCUTS) {
        root.querySelector(`[data-shortcut="${s.id}"]`).classList.toggle('hidden', apple && s.windowsOnly)
      }
    },
  })
}

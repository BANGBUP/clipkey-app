// The connected PCs by name, the one receiving keystrokes in green: one PC is a plain
// green name, two or three are buttons (one tap switches, e.g. the wired PC and a Bluetooth
// PC on ESP32-S3), more a selector. No PC: "PC 미연결".

import { TARGET } from './constants.js'
import { encodeSelectTarget, hostTitle } from './hosts.js'

const WIRED_VALUE = 'usb'
const MAX_BUTTONS = 3

/**
 * @param {{ client, sender, notify: (msg: string) => void, getHosts: () => Array }} deps
 */
export function setupTarget({ client, sender, notify, getHosts }) {
  const label = document.getElementById('targetLabel')
  let lastStatus = null
  let shownKey = '' // options + selection currently on screen
  function candidates(status) {
    const ble = getHosts()
      .filter((h) => h.connected)
      .map((h) => ({ value: h.addr.bytes.join('.'), title: hostTitle(h), host: h, active: h.active }))
    const wired = status.usbPc
      ? [{ value: WIRED_VALUE, title: '유선 PC', host: null, active: status.targetKind === TARGET.USB }]
      : []
    return [...wired, ...ble]
  }

  async function select(choice) {
    // Also text still waiting in the ClipKey's queue (the firmware refuses too). The queue
    // count can be stale (older firmware skips the "queue empty" update after a short text):
    // ask the device before refusing.
    if (!sender.active && (client.status?.queueUsed ?? 0) > 0) {
      await client.readStatus().catch(() => undefined)
    }
    if (sender.active || (client.status?.queueUsed ?? 0) > 0) {
      notify('타이핑 중에는 입력 대상을 바꿀 수 없습니다')
      render(lastStatus)
      return
    }
    const frame = choice.host
      ? encodeSelectTarget({ kind: TARGET.BLE, addr: choice.host.addr })
      : encodeSelectTarget({ kind: TARGET.USB })
    try {
      await client.send(frame)
      notify(`입력 대상: ${choice.title}`)
    } catch (error) {
      notify(`입력 대상 변경 실패: ${error.message}`)
      shownKey = '' // show the real target again
      render(lastStatus)
    }
  }

  function render(status) {
    lastStatus = status
    if (!status) {
      label.replaceChildren()
      return
    }
    const options = candidates(status)
    if (options.length < 2) shownKey = ''
    if (options.length === 0) {
      label.replaceChildren(pill(status.pcConnected ? '블루투스 PC' : 'PC 미연결', status.pcConnected ? 'on' : 'off'))
      return
    }
    if (options.length === 1) {
      label.replaceChildren(pill(options[0].title, 'on'))
      return
    }
    // Status updates arrive often while typing: don't rebuild (and close) an open selector.
    const current = (options.find((o) => o.active) ?? options[0]).value
    const key = `${options.map((o) => `${o.value}=${o.title}`).join('|')}#${current}`
    if (options.length <= MAX_BUTTONS) {
      if (key === shownKey && label.querySelector('.target-buttons')) return
      shownKey = key
      label.replaceChildren(buttons(options, current))
      return
    }
    const existing = label.querySelector('select')
    if (existing && (key === shownKey || document.activeElement === existing)) return
    shownKey = key
    const selectEl = Object.assign(document.createElement('select'), { className: 'inline-select target-select' })
    options.forEach((o) => selectEl.add(new Option(o.title, o.value)))
    selectEl.value = current
    selectEl.addEventListener('change', () => {
      selectEl.blur() // let the next status update redraw it with the real target
      select(options.find((o) => o.value === selectEl.value))
    })
    label.replaceChildren(selectEl)
  }

  function pill(text, state) {
    const el = Object.assign(document.createElement('span'), { className: `target-pill ${state}`, textContent: text })
    el.title = state === 'on' ? `입력 대상: ${text}` : '연결된 PC가 없습니다'
    return el
  }

  function buttons(options, current) {
    const group = Object.assign(document.createElement('div'), { className: 'target-buttons' })
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', '입력 대상')
    options.forEach((o) => {
      const on = o.value === current
      const button = Object.assign(document.createElement('button'), {
        type: 'button',
        className: `target-btn${on ? ' on' : ''}`,
        textContent: o.title,
        title: `${o.title}에 입력`,
      })
      button.setAttribute('aria-pressed', String(on))
      button.addEventListener('click', () => {
        if (on) return
        shownKey = '' // redraw from the next status (the device confirms the switch)
        select(o)
      })
      group.append(button)
    })
    return group
  }

  return Object.freeze({
    render,
    /** From the paired list: type on this host. */
    selectHost(host) {
      select({ host, title: hostTitle(host) })
    },
  })
}

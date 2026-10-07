// "입력 대상": which connected PC receives keystrokes. A plain label with one PC,
// a selector when there are several (Bluetooth PCs, plus the wired PC on ESP32-S3).

import { TARGET } from './constants.js'
import { encodeSelectTarget, hostTitle } from './hosts.js'

const WIRED_VALUE = 'usb'

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
      ? [{ value: WIRED_VALUE, title: '유선 연결 PC', host: null, active: status.targetKind === TARGET.USB }]
      : []
    return [...wired, ...ble]
  }

  async function select(choice) {
    // Also text still waiting in the ClipKey's queue (the firmware refuses too).
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
      label.replaceChildren(document.createTextNode(status.pcConnected ? '블루투스 PC' : ''))
      return
    }
    if (options.length === 1) {
      label.replaceChildren(document.createTextNode(options[0].title))
      return
    }
    // Status updates arrive often while typing: don't rebuild (and close) an open selector.
    const current = (options.find((o) => o.active) ?? options[0]).value
    const key = `${options.map((o) => `${o.value}=${o.title}`).join('|')}#${current}`
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

  return Object.freeze({
    render,
    /** From the paired list: type on this host. */
    selectHost(host) {
      select({ host, title: hostTitle(host) })
    },
  })
}

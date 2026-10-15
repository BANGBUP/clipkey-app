// 화면보호기 방지, per PC: one checkbox for the wired PC and each paired Bluetooth PC
// (firmware 1.0.31+). The device keeps the setting; the list mirrors its status / host list.

import { TARGET } from './constants.js'
import { encodeSetPcKeepAwake, hostTitle } from './hosts.js'

/**
 * @param {{ client, notify: (msg: string) => void, getHosts: () => Array, refreshHosts: () => void }} deps
 */
export function setupKeepAwakePcs({ client, notify, getHosts, refreshHosts }) {
  const box = document.getElementById('keepAwakePcs')
  let shownKey = ''

  async function change(pc, on, input) {
    try {
      await client.send(encodeSetPcKeepAwake({ kind: pc.kind, addr: pc.addr, on }))
      notify(`${pc.title}: 화면보호기 방지 ${on ? '켜짐' : '꺼짐'}`)
      if (pc.kind === TARGET.BLE) refreshHosts()
    } catch (error) {
      input.checked = !on
      notify(`설정 실패: ${error.message}`)
    }
  }

  function row(pc) {
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: pc.on })
    input.addEventListener('change', () => change(pc, input.checked, input))
    const label = Object.assign(document.createElement('label'), { className: 'check' })
    const state = pc.connected ? '' : ' (연결 안 됨)'
    label.append(input, ` ${pc.title}${state}`)
    return label
  }

  function render(status) {
    if (!status?.pcKeepAwake) {
      shownKey = ''
      box.replaceChildren()
      box.classList.add('hidden')
      return
    }
    const wired = status.usbOtg
      ? [{ kind: TARGET.USB, addr: null, title: '유선 PC', on: !status.usbAwakeOff, connected: status.usbPc }]
      : []
    const bluetooth = getHosts().map((h) => ({ kind: TARGET.BLE, addr: h.addr, title: hostTitle(h), on: !h.awakeOff, connected: h.connected }))
    const pcs = [...wired, ...bluetooth]
    const key = pcs.map((p) => `${p.title}:${p.on}:${p.connected}`).join('|')
    if (key === shownKey) return // don't rebuild under the user's finger on every status
    shownKey = key
    box.classList.toggle('hidden', pcs.length === 0)
    box.replaceChildren(
      Object.assign(document.createElement('span'), { className: 'hint', textContent: '보낼 PC' }),
      ...pcs.map(row),
    )
  }

  return Object.freeze({ render })
}

// The ClipKey's nickname: asked once after registering, editable in settings, stored on the device.

import { SECURE_MSG } from './constants.js'
import { encodeSetNickname } from './hosts.js'

/**
 * @param {{ client, notify: (msg: string) => void, onChange: (nickname: string) => void }} deps
 */
export function setupNickname({ client, notify, onChange }) {
  const $ = (id) => document.getElementById(id)
  const input = $('nicknameInput')
  let nickname = ''

  async function save(value) {
    if (!client.connected) return notify('먼저 기기에 연결하세요')
    try {
      await client.send(encodeSetNickname(value))
      notify(value.trim() ? `별명을 "${value.trim()}"(으)로 저장했습니다` : '별명을 지웠습니다')
    } catch (error) {
      notify(`별명 저장 실패: ${error.message}`)
    }
  }

  // After a fresh registration: offer to name this ClipKey right away.
  function askAfterRegister() {
    const dialog = $('nicknameDialog')
    const field = $('nicknameDialogInput')
    field.value = nickname
    dialog.returnValue = ''
    dialog.onclose = () => {
      if (dialog.returnValue === 'ok' && field.value.trim()) save(field.value)
    }
    dialog.showModal()
    field.focus()
  }

  // Which board this is, whatever its nickname: "ClipKey-0F22 · 88:13:BF:69:0F:22".
  function showDeviceId(mac) {
    const out = $('deviceIdInfo')
    if (!out) return
    if (mac === undefined) out.textContent = '-'
    else if (!mac) out.textContent = '펌웨어 1.0.30 이상에서 표시'
    else out.textContent = `ClipKey-${mac.slice(-5).replace(':', '')} · ${mac}`
  }

  $('nicknameSaveBtn').addEventListener('click', () => save(input.value))

  return Object.freeze({
    askAfterRegister,
    onSecure(msg) {
      if (msg.type !== SECURE_MSG.DEVICE_INFO) return
      nickname = msg.nickname
      if (document.activeElement !== input) input.value = nickname
      showDeviceId(msg.mac)
      onChange(nickname)
    },
    reset() {
      nickname = ''
      input.value = ''
      showDeviceId(undefined)
      onChange('')
    },
    get value() {
      return nickname
    },
  })
}

// USB(OTG) port mode: wired-keyboard device (default) or physical-keyboard host.
// Shows the host-mode warning bar whenever the device is (or was last seen) in host mode.

import { USB_MODE } from './constants.js'
import { encodeSetUsbMode } from './protocol.js'

const LAST_MODE_KEY = 'clipkey.lastHostMode.v1'

function rememberHostMode(hostMode) {
  try {
    localStorage.setItem(LAST_MODE_KEY, hostMode ? '1' : '0')
  } catch {
    // storage unavailable: the bar only reflects live status
  }
}

function lastHostMode() {
  try {
    return localStorage.getItem(LAST_MODE_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * @param {{ client, notify: (msg: string) => void }} deps
 */
export function setupUsbMode({ client, notify }) {
  const $ = (id) => document.getElementById(id)
  const radios = [...document.querySelectorAll('input[name="usbMode"]')]
  const dialog = $('hostWarn')
  let rebootPending = false

  const setRadio = (hostMode) => radios.forEach((r) => (r.checked = Number(r.value) === (hostMode ? 1 : 0)))

  function renderBar(hostMode, stale) {
    $('hostBar').classList.toggle('hidden', !hostMode)
    $('hostBarStale').classList.toggle('hidden', !stale)
  }

  // Asks for confirmation before host mode; resolves true to proceed. Settles on every
  // way the dialog can close (buttons, Escape, Android back gesture).
  function confirmHostMode() {
    return new Promise((resolve) => {
      dialog.returnValue = ''
      $('hostWarnOk').onclick = () => dialog.close('ok')
      $('hostWarnCancel').onclick = () => dialog.close('cancel')
      dialog.onclose = () => resolve(dialog.returnValue === 'ok')
      dialog.showModal()
    })
  }

  async function change(mode) {
    const current = client.status?.hostMode ? USB_MODE.HOST : USB_MODE.DEVICE
    if (!client.connected) {
      setRadio(lastHostMode())
      return notify('먼저 기기에 연결하세요')
    }
    if (mode === current) return
    if (mode === USB_MODE.HOST && !(await confirmHostMode())) {
      setRadio(current === USB_MODE.HOST)
      return
    }
    // Remember the target first: if the device reboots before we hear back, the
    // warning bar must already reflect host mode.
    rememberHostMode(mode === USB_MODE.HOST)
    renderBar(mode === USB_MODE.HOST, true)
    rebootPending = true
    try {
      await client.send(encodeSetUsbMode(mode))
      notify(mode === USB_MODE.HOST ? '호스트 모드로 전환합니다. 기기가 재부팅됩니다' : 'PC 연결 모드로 전환합니다. 기기가 재부팅됩니다')
    } catch (error) {
      if (!client.connected) {
        notify('기기가 재부팅 중입니다. 다시 연결하면 실제 모드를 확인합니다')
        return // onDisconnect handles the reconnect; status will correct the bar
      }
      rebootPending = false
      rememberHostMode(current === USB_MODE.HOST)
      renderBar(current === USB_MODE.HOST, false)
      setRadio(current === USB_MODE.HOST)
      notify(`모드 전환 실패: ${error.message}`)
    }
  }

  radios.forEach((r) => r.addEventListener('change', () => r.checked && change(Number(r.value))))
  renderBar(lastHostMode(), true)
  setRadio(lastHostMode())

  return Object.freeze({
    render(status) {
      radios.forEach((r) => (r.disabled = !status))
      if (!status) {
        renderBar(lastHostMode(), true)
        return
      }
      // Chips without USB-OTG (original ESP32) have no USB modes at all.
      $('usbModeField').classList.toggle('hidden', !status.usbOtg)
      rememberHostMode(status.hostMode)
      renderBar(status.hostMode, false)
      setRadio(status.hostMode)
    },
    // The app's auto-reconnect brings the link back after the reboot.
    onDisconnect() {
      if (!rebootPending) return
      rebootPending = false
      notify('기기가 재부팅됩니다. 자동으로 다시 연결합니다')
    },
  })
}

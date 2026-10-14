// "기기 초기화": asks the device to forget every phone and PC (FRAME.FACTORY_RESET), the same
// as holding BOOT for 5 seconds. The device restarts; this phone's registration is gone too.

import { askConfirm } from './modal.js'
import { encodeFactoryReset } from './protocol.js'

/**
 * @param {{ $: (id: string) => HTMLElement, client: object, notify: (msg: string) => void,
 *           log: (line: string) => void, beforeReset: () => void, afterReset: () => void,
 *           onFailed: () => void }} deps
 *   beforeReset: no auto-reconnect for the drop that follows (the device restarts);
 *   afterReset: forget this device's token and disconnect; onFailed: undo beforeReset
 */
export function setupFactoryReset({ $, client, notify, log, beforeReset, afterReset, onFailed }) {
  const button = $('factoryResetBtn')
  button.addEventListener('click', async () => {
    if (!client.connected) {
      notify('먼저 초기화할 기기에 연결하세요. 연결이 안 되면 기기의 BOOT 버튼을 5초 누르세요')
      return
    }
    const ok = await askConfirm(
      `${client.deviceName || '이 기기'}를 초기화할까요?\n\n등록된 폰과 페어링된 PC가 모두 지워지고 기기가 다시 시작합니다. 다시 쓰려면 기기의 BOOT 버튼을 짧게 누른 뒤 이 폰을 새로 등록하고, PC도 다시 페어링해야 합니다.`,
      { okText: '초기화', cancelText: '취소' },
    )
    if (!ok) return
    button.disabled = true
    beforeReset()
    try {
      await client.send(encodeFactoryReset())
      log('factory reset requested')
      afterReset()
      notify('기기를 초기화했습니다. 다시 쓰려면 BOOT 버튼을 짧게 누른 뒤 새로 등록하세요')
    } catch (error) {
      log(`factory reset failed: ${error.message}`)
      onFailed()
      notify('이 펌웨어는 앱에서 초기화할 수 없습니다. 펌웨어를 업데이트하거나 기기의 BOOT 버튼을 5초 누르세요')
    } finally {
      button.disabled = false
    }
  })
}

// Setup code UI: asked when this phone registers, offered after a code-less (BOOT) registration,
// and changeable in the settings.

import { USE_BOOT_WINDOW } from './ble.js'
import { encodeSetSetupCode } from './protocol.js'

/** @param {{ client, notify: (msg: string) => void }} deps */
export function setupSetupCode({ client, notify }) {
  const $ = (id) => document.getElementById(id)

  /** Code dialog for registering: a code, USE_BOOT_WINDOW, or null when cancelled. */
  function ask({ bootRegistration = true } = {}) {
    const dialog = $('codeDialog')
    const input = $('codeInput')
    input.value = ''
    // Older firmware has no BOOT registration: don't offer it.
    dialog.querySelectorAll('[data-boot]').forEach((el) => el.classList.toggle('hidden', !bootRegistration))
    return new Promise((resolve) => {
      dialog.onclose = () => {
        if (dialog.returnValue === 'boot') return resolve(USE_BOOT_WINDOW)
        resolve(dialog.returnValue === 'ok' && /^\d{4,12}$/.test(input.value) ? input.value : null)
      }
      dialog.returnValue = ''
      dialog.showModal()
      input.focus()
    })
  }

  async function save(code, done) {
    try {
      await client.send(encodeSetSetupCode(code))
      notify(done)
      return true
    } catch (error) {
      notify(`설정 코드 저장 실패: ${error.message}`)
      return false
    }
  }

  /** After registering with BOOT on a ClipKey without a code: setting one is optional. */
  async function offer() {
    const code = prompt(
      '이 ClipKey에는 설정 코드가 없습니다(선택 사항).\n' +
        '코드를 정하면 다른 폰을 BOOT 버튼 없이 그 코드로 등록할 수 있습니다.\n' +
        '정하려면 숫자 4~12자리를 입력하세요 (0000 제외). 건너뛰려면 취소:',
    )
    if (code === null || code.trim() === '') return
    await save(code.trim(), '설정 코드를 저장했습니다. 다른 폰은 이 코드로도 등록할 수 있습니다')
  }

  $('setupCodeBtn').addEventListener('click', async () => {
    if (!client.connected) return notify('먼저 기기에 연결하세요')
    if (await save($('setupCodeInput').value, '설정 코드를 바꿨습니다. 이미 등록된 폰은 그대로 쓸 수 있습니다')) {
      $('setupCodeInput').value = ''
    }
  })

  return Object.freeze({ ask, offer })
}

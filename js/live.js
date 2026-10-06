// "Live" tab: mirrors a phone text field onto the PC as it is edited.

import { diffText } from './diff.js'
import { normalizeText } from './keymap.js'
import { OP, KEY } from './constants.js'
import { encodeToggleIme } from './protocol.js'

const NAV_KEYS = Object.freeze({
  esc: KEY.ESC,
  tab: KEY.TAB,
  enter: KEY.ENTER,
  up: KEY.UP,
  down: KEY.DOWN,
  left: KEY.LEFT,
  right: KEY.RIGHT,
})

/**
 * @param {{ field: HTMLTextAreaElement, keypad: HTMLElement, resetBtn: HTMLElement,
 *           composingToggle: HTMLInputElement, client, sender, notify: (msg: string) => void }} deps
 */
export function setupLive({ field, keypad, resetBtn, composingToggle, client, sender, notify }) {
  // Text the PC is believed to contain (since the last reset), ending at the PC caret.
  let baseline = ''

  const report = (error) => notify(`전송 실패: ${error.message}`)

  function reset() {
    field.value = ''
    baseline = ''
  }

  // If an edit did not fully reach the PC, the PC text is unknown: start over.
  function desync(message) {
    reset()
    notify(`${message} — PC 내용과 맞지 않을 수 있어 입력칸을 비웠습니다`)
  }

  function flush() {
    if (!client.connected) return
    // Diff what the PC actually received (normalized), so "…" = 3 backspaces, NBSP = 1, etc.
    const next = normalizeText(field.value)
    const edit = diffText(baseline, next)
    baseline = next
    sender
      .sendEdit(edit)
      .then(({ skipped, completed }) => {
        if (!completed) desync('전송이 취소되었습니다')
        else if (skipped > 0) notify(`지원하지 않는 문자 ${skipped}개는 건너뛰었습니다`)
      })
      .catch((error) => desync(`전송 실패: ${error.message}`))
  }

  field.addEventListener('input', (event) => {
    if (event.isComposing && !composingToggle.checked) return
    flush()
  })
  field.addEventListener('compositionend', flush)
  resetBtn.addEventListener('click', reset)

  keypad.addEventListener('click', (event) => {
    const key = event.target.closest('[data-key]')?.dataset.key
    if (!key) return
    if (!client.connected) {
      notify('먼저 기기에 연결하세요')
      return
    }
    if (key === 'ime') {
      client.send(encodeToggleIme()).catch(report)
      return
    }
    if (key === 'backspace' && field.value.length > 0) {
      // Keep phone and PC in step: delete the last character on both.
      field.value = [...field.value].slice(0, -1).join('')
      flush()
      return
    }
    const code = key === 'backspace' ? KEY.BACKSPACE : NAV_KEYS[key]
    if (code === undefined) return
    // Navigation moves the PC caret away from our baseline, so start a fresh one.
    if (key !== 'backspace') reset()
    sender.sendOps([{ type: OP.TAP, key: code, mod: 0 }]).catch(report)
  })

  return Object.freeze({
    setEnabled(enabled) {
      field.disabled = !enabled
      if (!enabled) reset()
    },
  })
}

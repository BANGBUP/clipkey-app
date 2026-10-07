// Debug panel: shows appLog (recorded from app start) at the bottom when enabled in settings.

import { appLog } from './log.js'
import { createStore } from './lists.js'

const flagStore = createStore(
  { getItem: (k) => localStorage.getItem(k), setItem: (k, v) => localStorage.setItem(k, v) },
  'clipkey.debug.v1',
  false,
  (v) => v === true,
)

/** @param {{ notify: (msg: string) => void }} deps */
export function setupDebug({ notify }) {
  const $ = (id) => document.getElementById(id)
  const panel = $('debugPanel')
  const pre = $('debugLog')
  const toggle = $('debugEnabled')

  const render = () => {
    pre.textContent = appLog.lines().join('\n')
    pre.scrollTop = pre.scrollHeight
  }

  function show(enabled) {
    panel.classList.toggle('hidden', !enabled)
    toggle.checked = enabled
    if (enabled) render()
  }

  appLog.subscribe(() => {
    if (!panel.classList.contains('hidden')) render()
  })
  toggle.addEventListener('change', () => {
    flagStore.save(toggle.checked)
    show(toggle.checked)
  })
  $('debugCopyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(appLog.lines().join('\n'))
      notify('로그를 복사했습니다')
    } catch (error) {
      notify(`복사 실패: ${error.message}`)
    }
  })
  $('debugClearBtn').addEventListener('click', () => {
    appLog.clear()
    render()
  })

  show(flagStore.load())
}

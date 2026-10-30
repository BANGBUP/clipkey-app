// "트레이로 압축 보내기" buttons on the 보내기 tab: the text box or a file goes deflated and as
// base64 to the PC tray's receive window. Typed faster than normal (settings: packDelay); the
// normal key interval comes back once the device has typed everything.

import { packText, textPayload, filePayload } from './packed.js'
import { encodeSetDelay } from './protocol.js'
import { askConfirm } from './modal.js'
import { formatDuration as seconds } from './sendstats.js'

const IDLE_POLL_MS = 300
const CONFIRM_OVER_S = 60
const BLE_REPORT_MS = 7.5 // at best one key report per link event

/**
 * @param {{ $: (id: string) => HTMLElement, client: object, sender: object, notify: (m: string) => void,
 *           log: (m: string) => void, getSettings: () => object, getText: () => string }} deps
 */
export function setupPackSend({ $, client, sender, notify, log, getSettings, getText }) {
  let busy = false

  // Done typing: the device's queue is empty (or the link or the job is gone).
  async function waitDeviceIdle(jobGeneration) {
    while (client.connected && sender.generation === jobGeneration) {
      const status = await client.readStatus()
      if (status.queueUsed === 0) return
      await new Promise((r) => setTimeout(r, IDLE_POLL_MS))
    }
  }

  async function send(label, makePayload) {
    if (!client.connected) return notify('먼저 기기에 연결하세요')
    if (busy || sender.active) return notify('지금 타이핑 중입니다. 끝난 뒤에 보내세요')
    busy = true
    const settings = getSettings()
    try {
      const payload = await makePayload()
      const typed = packText(payload)
      const estimate = typed.length * 2 * Math.max(settings.packDelay, BLE_REPORT_MS)
      const ok =
        estimate < CONFIRM_OVER_S * 1000 ||
        (await askConfirm(`${label}: ${typed.length}자, 약 ${seconds(estimate)} 걸립니다. 보낼까요?`, { okText: '보내기' }))
      if (!ok) return
      const jobGeneration = sender.generation
      await waitDeviceIdle(jobGeneration) // text typed before this must not go at the fast interval
      notify(`PC의 'ClipKey 받기' 창을 앞에 두세요. ${typed.length}자 보내는 중`)
      log(`pack send: payload ${payload.length} B, ${typed.length} chars at ${settings.packDelay} ms`)
      const started = performance.now()
      await sender.sendFrame(encodeSetDelay(settings.packDelay, settings.packDelay))
      const { completed } = await sender.sendText(typed)
      if (completed) await waitDeviceIdle(jobGeneration)
      if (!completed || sender.generation !== jobGeneration || !client.connected) return notify('보내기를 멈췄습니다')
      const took = performance.now() - started
      log(`pack send done: ${typed.length} chars in ${Math.round(took)} ms`)
      notify(`보냈습니다(${label}): ${typed.length}자, ${seconds(took)} (초당 ${Math.round(typed.length / (took / 1000))}자)`)
    } catch (error) {
      notify(`보내지 못했습니다: ${error.message}`)
    } finally {
      busy = false
      // A lost link gets the normal interval back with the settings on reconnect.
      const now = getSettings() // changed meanwhile: keep the new value
      if (client.connected) sender.sendFrame(encodeSetDelay(now.delay, now.appleDelay)).catch(() => {})
    }
  }

  // While this runs, other texts must wait: they would be typed at the fast interval.
  const isBusy = () => busy

  $('packSendBtn').addEventListener('click', () => {
    const text = getText()
    if (!text) return notify('보낼 텍스트가 없습니다')
    send('텍스트', () => textPayload(text))
  })
  const fileInput = $('packFileInput')
  $('packFileBtn').addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    fileInput.value = '' // the same file can be picked again
    if (file) send(`파일 ${file.name}`, async () => filePayload(file.name, new Uint8Array(await file.arrayBuffer())))
  })
  return Object.freeze({ isBusy })
}

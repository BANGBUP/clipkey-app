// "받기" tab: text sent from the PC (clipkey-send.ps1) arrives here. Received texts stay in
// memory only (they may be passwords); just the auto-copy preference is saved.

import { SECURE_MSG } from './constants.js'
import {
  EMPTY_RX, EMPTY_PARTS, reducePcRx, addPart, partsToResend, partsLeft, formatParts, storeParts, loadParts,
  payloadEvent, inflateText, inflateBytes, textOf, charCount,
} from './pcrx.js'

const MAX_ITEMS = 10
const PREF_KEY = 'clipkey.pcrx.v1'
// Pieces of an unfinished split payload, so closing the app does not lose them (이어받기).
// Dropped when complete, after a day, or with 모두 지우기.
const PARTS_KEY = 'clipkey.pcrx.parts.v1'
const PARTS_KEEP_MS = 24 * 60 * 60 * 1000
const SAME_SEND_MS = 120_000 // longer than one 1 KB piece takes, even with Bluetooth lag
const PARTS_MAX_CHARS = 3_000_000 // localStorage holds about 5 MB: bigger ones stay in memory only

function readStoredParts() {
  try {
    return loadParts(JSON.parse(localStorage.getItem(PARTS_KEY) ?? 'null'), Date.now(), PARTS_KEEP_MS)
  } catch {
    return EMPTY_PARTS
  }
}

function writeStoredParts(parts) {
  try {
    const text = parts.count ? JSON.stringify(storeParts(parts, Date.now())) : ''
    if (text && text.length <= PARTS_MAX_CHARS) localStorage.setItem(PARTS_KEY, text)
    else localStorage.removeItem(PARTS_KEY)
  } catch {
    // storage full or unavailable: the pieces last while the app stays open (and an older
    // set must not come back in their place)
    try {
      localStorage.removeItem(PARTS_KEY)
    } catch {
      // unavailable
    }
  }
}

const resumeHint = (parts) => `PC 트레이의 '이어 보내기'에 ${formatParts(partsLeft(parts))} 을 넣어 남은 조각을 보내세요`

function loadAutoCopy() {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}').autoCopy === true
  } catch {
    return false
  }
}

function saveAutoCopy(autoCopy) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ autoCopy }))
  } catch {
    // storage unavailable: lasts for this session only
  }
}

// Saves the bytes as a download (Android: the Downloads folder).
function saveFile(name, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

const timeLabel = (date) => date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/**
 * @param {{ notify: (msg: string) => void, toSendTab: (text: string) => void }} deps
 */
export function setupPcReceive({ notify, toSendTab }) {
  const $ = (id) => document.getElementById(id)
  const tab = document.querySelector('.tab[data-tab="receive"]')
  let rx = EMPTY_RX
  let parts = readStoredParts() // pieces of a split payload, kept until all are in
  let partsHave = parts.pieces.filter(Boolean).length
  // A piece of the kept set came in since the last whole text: what stops now belongs to it.
  let partsActive = false
  let lastDone = null // { id, count, at }: a set already joined (a full resend goes on after it)
  const setParts = (next) => {
    parts = next
    writeStoredParts(parts)
  }
  let items = [] // newest first: { id, text, size, at }
  let nextId = 1

  const autoCopyBox = $('pcRxAutoCopy')
  autoCopyBox.checked = loadAutoCopy()
  autoCopyBox.addEventListener('change', () => saveAutoCopy(autoCopyBox.checked))

  function setStatus(text, progress) {
    $('pcRxStatus').textContent = text
    const bar = $('pcRxBar')
    bar.classList.toggle('hidden', !progress)
    if (progress) {
      bar.max = Math.max(progress.total, 1)
      bar.value = progress.received
    }
  }

  // "수신 N%" next to the 유선 / 블투 chips while a PC sends; a tap opens the 받기 tab.
  // When the automatic copy is refused (Android wants a recent tap for the clipboard), the
  // chip turns into "복사": tapping it is that tap, on whatever tab is open.
  const chip = document.querySelector('.chip[data-chip="rx"]')
  let pendingCopy = null
  chip.addEventListener('click', () => {
    if (pendingCopy === null) return tab.click()
    const text = pendingCopy
    pendingCopy = null
    setChip(null)
    copy(text, 'PC에서 받은 텍스트를 복사했습니다')
  })
  function setChip(progress) {
    if (progress !== null) pendingCopy = null
    chip.classList.toggle('hidden', progress === null)
    if (progress !== null) chip.textContent = `수신 ${progress}`
  }
  function offerCopy(text) {
    pendingCopy = text
    chip.textContent = '눌러서 복사'
    chip.classList.remove('hidden')
  }

  const markUnseen = () => $('receiveDot').classList.toggle('hidden', tab.classList.contains('active'))
  tab.addEventListener('click', () => $('receiveDot').classList.add('hidden'))

  async function copy(text, done = '복사됨') {
    try {
      await navigator.clipboard.writeText(text)
      notify(done)
      return true
    } catch (error) {
      notify(`복사하지 못했습니다(${error.message}). 받기 탭의 "복사" 버튼을 누르세요`)
      return false
    }
  }

  // Received with auto-copy on: no tap came with it, which the phone may refuse.
  async function autoCopy(text) {
    try {
      await navigator.clipboard.writeText(text)
      notify('PC에서 텍스트를 받아 클립보드에 복사했습니다')
    } catch {
      offerCopy(text)
      notify('PC에서 텍스트를 받았습니다. 위의 "눌러서 복사"를 누르면 복사됩니다')
    }
  }

  function itemView(item) {
    const box = document.createElement('div')
    box.className = 'rx-item'
    const head = document.createElement('div')
    head.className = 'hint'
    const packed = item.compressed ? ` (압축 ${item.size}바이트)` : ` · ${item.size}바이트`
    const what = item.damaged
      ? `깨진 받기 · ${item.size}바이트`
      : item.file
      ? `파일 ${item.file.name} · ${item.file.bytes.length}바이트${item.compressed ? ` (압축 ${item.size}바이트)` : ''}`
      : `${charCount(item.text)}자${packed}`
    head.textContent = `${timeLabel(item.at)} · ${what}`
    const text = document.createElement('pre')
    text.className = 'rx-text'
    text.textContent =
      item.text ??
      (item.damaged
        ? '(전송 중 깨진 내용: 원인을 찾는 데 씁니다. 저장해서 보낸 원본 파일과 함께 전달해 주세요)'
        : '(텍스트가 아닌 파일: 저장해서 여세요)')
    const actions = document.createElement('div')
    actions.className = 'row'
    const action = (label, run, extra = '') => {
      const b = document.createElement('button')
      b.className = `btn small ${extra}`
      b.textContent = label
      b.addEventListener('click', run)
      return b
    }
    const toggle = action('펼치기', () => {
      const open = box.classList.toggle('expanded')
      toggle.textContent = open ? '접기' : '펼치기'
      toggle.setAttribute('aria-expanded', String(open))
    })
    toggle.setAttribute('aria-expanded', 'false')
    text.addEventListener('click', () => toggle.click())
    const textActions =
      item.text === null
        ? []
        : [action('복사', () => copy(item.text)), action('보내기 탭으로', () => toSendTab(item.text))]
    const fileActions = item.file ? [action('저장', () => saveFile(item.file.name, item.file.bytes))] : []
    actions.append(
      ...textActions,
      ...fileActions,
      action('삭제', () => setItems(items.filter((i) => i.id !== item.id)), 'danger'),
    )
    // 펼치기 / 접기 at the top right: an opened long text needs no scrolling to close it
    const top = document.createElement('div')
    top.className = 'rx-head'
    top.append(head)
    if (item.text !== null) top.append(toggle)
    box.append(top, text, actions)
    return box
  }

  function setItems(next) {
    items = next
    $('pcRxList').replaceChildren(...items.map(itemView))
    $('pcRxEmpty').classList.toggle('hidden', items.length > 0)
  }

  async function received(text, size, compressed = false) {
    setItems([{ id: nextId++, text, file: null, size, compressed, at: new Date() }, ...items].slice(0, MAX_ITEMS))
    setStatus(`완료: ${charCount(text)}자를 받았습니다`)
    markUnseen()
    if (autoCopyBox.checked) await autoCopy(text)
    else notify('PC에서 텍스트를 받았습니다')
  }

  async function receivedFile({ name, deflated, data, size }) {
    const bytes = deflated ? await inflateBytes(data) : data
    const text = textOf(bytes)
    setItems([{ id: nextId++, text, file: { name, bytes }, size, compressed: deflated, at: new Date() }, ...items].slice(0, MAX_ITEMS))
    setStatus(`완료: 파일 ${name} (${bytes.length}바이트)를 받았습니다`)
    markUnseen()
    notify(`PC에서 파일 ${name}을 받았습니다. 받기 탭에서 저장하세요`)
  }

  const failed = (reason) => {
    setStatus(`실패: ${reason}`)
    notify(`PC에서 받기 실패: ${reason}`)
    markUnseen()
  }

  // A frame whose checksum failed: keep what arrived (to compare with the original) and,
  // for a split payload, say which pieces to send again.
  function failedFrame(event) {
    const resend = partsToResend(parts, event.damaged)
    if (event.damaged) {
      const stamp = new Date().toTimeString().slice(0, 8).replaceAll(':', '')
      const file = { name: `clipkey-damaged-${stamp}.bin`, bytes: event.damaged }
      const item = { id: nextId++, text: null, file, size: event.damaged.length, compressed: false, damaged: true, at: new Date() }
      setItems([item, ...items].slice(0, MAX_ITEMS))
    }
    // Stopped: everything not yet in is left. A bad frame while the PC goes on: the broken ones.
    const again =
      event.stopped && parts.count
        ? partsActive
          ? ` 조각 ${partsHave}/${parts.count}개는 남겨 두었습니다. ${resumeHint(parts)}.`
          : ` 이어받으려고 남겨 둔 조각 ${partsHave}/${parts.count}개는 그대로입니다.`
        : resend.length
        ? ` 다 보낸 뒤 트레이의 '이어 보내기'에 ${formatParts(resend)} 을 넣어 다시 보내세요.`
        : ''
    const kept = event.damaged ? " 깨진 내용은 목록에 '깨진 받기'로 남겼습니다." : ''
    setStatus(`실패: ${event.reason}.${again}${kept}`)
    notify(`PC에서 받기 실패: ${event.reason}`)
    markUnseen()
  }

  function onSecure(msg) {
    if (msg.type !== SECURE_MSG.PC_RX && msg.type !== SECURE_MSG.PC_TEXT) return
    const result = reducePcRx(rx, msg)
    rx = result.rx
    const event = result.event
    if (!event) return
    if (event.type !== 'progress') setChip(null)
    if (event.type === 'progress') {
      const percent = Math.floor((100 * event.received) / Math.max(event.total, 1))
      const piece = parts.count && partsActive ? `조각 ${Math.min(partsHave + 1, parts.count)}/${parts.count} ` : ''
      setStatus(`받는 중 ${piece}${percent}% (${event.received}/${event.total}바이트)`, event)
      setChip(`${piece}${percent}%`)
      if (event.starting) markUnseen()
    } else if (event.type === 'part') {
      onPart(event)
    } else {
      if (event.type !== 'failed') partsActive = false // a whole text in one frame
      onPayload(event)
    }
  }

  // A payload too big for one frame comes in pieces (clipkey-send.ps1 splits it).
  function onPart(part) {
    const joined = lastDone && lastDone.id === part.id && lastDone.count === part.count
    // Only while that send goes on (pieces a few seconds apart): sent again later, it is new.
    if (joined && part.index > 0 && Date.now() - lastDone.at < SAME_SEND_MS) {
      lastDone = { ...lastDone, at: Date.now() }
      setStatus(`이미 다 받은 내용의 조각 ${part.index + 1}/${part.count}: 건너뜁니다`)
      return
    }
    const replaced = parts.count > 0 && (part.id !== parts.id || part.count !== parts.count)
    const result = addPart(parts, part)
    setParts(result.parts)
    partsActive = true
    partsHave = result.payload || result.mixed ? 0 : result.have
    if (result.mixed) {
      failed('조각을 다 모았지만 내용이 맞지 않습니다(다른 내용의 조각이 섞임). 처음부터 다시 보내세요')
      return
    }
    if (result.payload) {
      lastDone = { id: part.id, count: part.count, at: Date.now() }
      partsActive = false
      onPayload(payloadEvent(result.payload))
      return
    }
    if (replaced) notify('남겨 둔 조각과 다른 내용이 와서 새로 받습니다 (PC의 클립보드나 파일이 바뀌었는지 확인하세요)')
    const missing = result.missing.length
      ? `. 빠진 조각 ${formatParts(result.missing)}: 다 보낸 뒤 PC 트레이의 '이어 보내기'에 넣어 다시 보내세요`
      : ''
    setStatus(`조각 ${result.have}/${part.count}개 받음${missing}`)
    markUnseen()
  }

  function onPayload(event) {
    if (event.type === 'done' && event.compressed) {
      inflateText(event.compressed)
        .then((text) => received(text, event.size, true))
        .catch(() => failed('압축을 풀지 못했습니다'))
    } else if (event.type === 'file') {
      receivedFile(event).catch(() => failed('파일 압축을 풀지 못했습니다'))
    } else if (event.type === 'done') {
      received(event.text, event.size)
    } else if (event.type === 'failed') {
      failedFrame(event)
    }
  }

  $('pcRxClearBtn').addEventListener('click', () => {
    setItems([])
    if (!parts.count) return
    setParts(EMPTY_PARTS)
    partsHave = 0
    setStatus('대기 중 (이어받으려고 남겨 둔 조각도 지웠습니다)')
  })
  $('pcRxCmdCopy').addEventListener('click', () => copy($('pcRxCmd').textContent, '명령을 복사했습니다'))
  setItems([])
  if (parts.count) setStatus(`이어받기 대기: 조각 ${partsHave}/${parts.count}개를 받아 두었습니다. ${resumeHint(parts)}`)

  return Object.freeze({
    onSecure,
    /** The link dropped: a half-received text is gone (the list stays). */
    reset() {
      rx = { ...rx, buffer: null }
      setChip(null)
      if (!$('pcRxStatus').textContent.startsWith('받는 중')) return
      setStatus(
        parts.count && partsActive
          ? `연결이 끊겼습니다. 조각 ${partsHave}/${parts.count}개는 남겨 두었습니다. 다시 연결한 뒤 ${resumeHint(parts)}`
          : '대기 중 (연결이 끊겨 받던 텍스트는 버렸습니다)',
      )
    },
  })
}

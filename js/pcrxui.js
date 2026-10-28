// "받기" tab: text sent from the PC (clipkey-send.ps1) arrives here. Received texts stay in
// memory only (they may be passwords); just the auto-copy preference is saved.

import { SECURE_MSG } from './constants.js'
import { EMPTY_RX, EMPTY_PARTS, reducePcRx, addPart, payloadEvent, inflateText, inflateBytes, textOf, charCount } from './pcrx.js'

const MAX_ITEMS = 10
const PREF_KEY = 'clipkey.pcrx.v1'

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
  let parts = EMPTY_PARTS // pieces of a split payload, kept until all are in
  let partsHave = 0
  let items = [] // newest first: { id, text, size, at }
  let nextId = 1

  const autoCopy = $('pcRxAutoCopy')
  autoCopy.checked = loadAutoCopy()
  autoCopy.addEventListener('change', () => saveAutoCopy(autoCopy.checked))

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
  const chip = document.querySelector('.chip[data-chip="rx"]')
  chip.addEventListener('click', () => tab.click())
  function setChip(progress) {
    chip.classList.toggle('hidden', progress === null)
    if (progress !== null) chip.textContent = `수신 ${progress}`
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

  function itemView(item) {
    const box = document.createElement('div')
    box.className = 'rx-item'
    const head = document.createElement('div')
    head.className = 'hint'
    const packed = item.compressed ? ` (압축 ${item.size}바이트)` : ` · ${item.size}바이트`
    const what = item.file
      ? `파일 ${item.file.name} · ${item.file.bytes.length}바이트${item.compressed ? ` (압축 ${item.size}바이트)` : ''}`
      : `${charCount(item.text)}자${packed}`
    head.textContent = `${timeLabel(item.at)} · ${what}`
    const text = document.createElement('pre')
    text.className = 'rx-text'
    text.textContent = item.text ?? '(텍스트가 아닌 파일: 저장해서 여세요)'
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
    if (autoCopy.checked) await copy(text, 'PC에서 텍스트를 받아 클립보드에 복사했습니다')
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

  function onSecure(msg) {
    if (msg.type !== SECURE_MSG.PC_RX && msg.type !== SECURE_MSG.PC_TEXT) return
    const result = reducePcRx(rx, msg)
    rx = result.rx
    const event = result.event
    if (!event) return
    if (event.type !== 'progress') setChip(null)
    if (event.type === 'progress') {
      const percent = Math.floor((100 * event.received) / Math.max(event.total, 1))
      const piece = parts.count ? `조각 ${Math.min(partsHave + 1, parts.count)}/${parts.count} ` : ''
      setStatus(`받는 중 ${piece}${percent}% (${event.received}/${event.total}바이트)`, event)
      setChip(`${piece}${percent}%`)
      if (event.starting) markUnseen()
    } else if (event.type === 'part') {
      onPart(event)
    } else {
      onPayload(event)
    }
  }

  // A payload too big for one frame comes in pieces (clipkey-send.ps1 splits it).
  function onPart(part) {
    const result = addPart(parts, part)
    parts = result.parts
    partsHave = result.payload ? 0 : result.have
    if (result.payload) {
      onPayload(payloadEvent(result.payload))
      return
    }
    const missing = result.missing.length
      ? `. 빠진 조각 ${result.missing.join(',')}: PC 트레이의 '빠진 조각 다시 보내기' 또는 -Parts ${result.missing.join(',')} 로 다시 보내세요`
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
      failed(event.reason)
    }
  }

  $('pcRxClearBtn').addEventListener('click', () => setItems([]))
  $('pcRxCmdCopy').addEventListener('click', () => copy($('pcRxCmd').textContent, '명령을 복사했습니다'))
  setItems([])

  return Object.freeze({
    onSecure,
    /** The link dropped: a half-received text is gone (the list stays). */
    reset() {
      rx = { ...rx, buffer: null }
      setChip(null)
      if ($('pcRxStatus').textContent.startsWith('받는 중')) setStatus('대기 중 (연결이 끊겨 받던 텍스트는 버렸습니다)')
    },
  })
}

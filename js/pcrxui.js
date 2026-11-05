// "받기" tab: text sent from the PC (clipkey-send.ps1) arrives here. Received texts stay in
// memory only (they may be passwords); just the auto-copy preference is saved.

import { SECURE_MSG } from './constants.js'
import { EMPTY_RX, EMPTY_PARTS, reducePcRx, partsToResend, parsePart, payloadEvent, inflateText, inflateBytes, textOf, charCount } from './pcrx.js'
import { addPiece, noteInfo, removeSet, findSet, keyOf, haveOf, partsLeft, formatParts, setName } from './pcrxsets.js'
import { readHeld, writeHeld, setupHeldList } from './pcrxheld.js'

const MAX_ITEMS = 10
const PREF_KEY = 'clipkey.pcrx.v1'
const SAME_SEND_MS = 120_000 // longer than one 1 KB piece takes, even with Bluetooth lag
// A frame starting this soon after a piece (pieces are 0.5 s apart) is the same send's next one;
// later, it may be anything (a short text sent in between).
const NEXT_FRAME_MS = 5_000

const resumeHint = (set) =>
  `PC 트레이의 '이어 보내기'에서 ${setName(set)}을(를) 고르면 남은 조각(${formatParts(partsLeft(set))})을 보냅니다`

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
  // 중단된 받기: split sends kept until complete (each its own, so others can go in between)
  let held = readHeld()
  let activeKey = null // the send whose pieces are coming in now
  let lastDone = null // { key, at }: a send already joined (a full resend goes on after it)
  let lastPieceAt = 0
  const active = () => (activeKey ? held.find((s) => s.key === activeKey) ?? null : null)
  const renderHeld = setupHeldList({
    box: $('pcRxHeldBox'),
    list: $('pcRxHeld'),
    onDelete: (key) => {
      if (activeKey === key) activeKey = null
      setHeld(removeSet(held, key))
      notify('중단된 받기를 지웠습니다')
    },
  })
  function setHeld(next, dropped = []) {
    const saved = writeHeld(next)
    held = saved.sets
    renderHeld(held)
    const gone = [...dropped, ...saved.dropped]
    if (gone.length) notify(`중단된 받기가 많거나 커서 오래된 ${gone.map(setName).join(', ')}을(를) 지웠습니다`)
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
  // for a split payload, say which pieces to send again. Stopped: the send waits in the list.
  function failedFrame(event) {
    // The broken frame's own header says whose piece it was, if it was one.
    const hint = event.damaged ? parsePart(event.damaged) : null
    const set = (hint && findSet(held, hint)) ?? (hint ? null : active())
    const resend = partsToResend(set ?? EMPTY_PARTS, event.damaged)
    if (event.damaged) {
      const stamp = new Date().toTimeString().slice(0, 8).replaceAll(':', '')
      const file = { name: `clipkey-damaged-${stamp}.bin`, bytes: event.damaged }
      const item = { id: nextId++, text: null, file, size: event.damaged.length, compressed: false, damaged: true, at: new Date() }
      setItems([item, ...items].slice(0, MAX_ITEMS))
    }
    const again =
      event.stopped && set
        ? ` ${setName(set)}의 조각 ${haveOf(set)}/${set.count}개를 '중단된 받기'에 보관했습니다. ${resumeHint(set)}.`
        : resend.length
        ? ` 다 보낸 뒤 트레이의 '빠진 조각 다시 보내기'에 ${formatParts(resend)} 을 넣어 다시 보내세요.`
        : ''
    if (event.stopped) activeKey = null // what comes next may be something else
    const kept = event.damaged ? " 깨진 내용은 목록에 '깨진 받기'로 남겼습니다." : ''
    setStatus(`실패: ${event.reason}.${again}${kept}`)
    notify(`PC에서 받기 실패: ${event.reason}`)
    markUnseen()
  }

  const short = (name) => (name.length > 24 ? `${name.slice(0, 23)}…` : name)

  function onSecure(msg) {
    if (msg.type !== SECURE_MSG.PC_RX && msg.type !== SECURE_MSG.PC_TEXT) return
    const result = reducePcRx(rx, msg)
    rx = result.rx
    const event = result.event
    if (!event) return
    if (event.type !== 'progress') setChip(null)
    if (event.type === 'progress') {
      const percent = Math.floor((100 * event.received) / Math.max(event.total, 1))
      if (event.starting && Date.now() - lastPieceAt > NEXT_FRAME_MS) activeKey = null
      const set = active()
      // Which piece is coming is only known once it is in (its number is inside), so: how many
      // are in so far, and how far the one coming now is.
      const have = set ? `${short(setName(set))} ${haveOf(set)}/${set.count}조각 받음 · 지금 조각 ` : ''
      setStatus(`받는 중 ${have}${percent}% (${event.received}/${event.total}바이트)`, event)
      setChip(set ? `${haveOf(set)}/${set.count} +${percent}%` : `${percent}%`)
      if (event.starting) markUnseen()
    } else if (event.type === 'part') {
      onPart(event)
    } else if (event.type === 'info') {
      onInfo(event)
    } else if (event.type === 'cancel') {
      onCancel(event)
    } else {
      if (event.type !== 'failed') activeKey = null // a whole text in one frame
      onPayload(event)
    }
  }

  // The PC names a split send before its pieces (new scripts): it shows in the list at once.
  function onInfo(info) {
    if (lastDone?.key === keyOf(info)) lastDone = null // the same content sent again: a new send
    lastPieceAt = Date.now()
    const result = noteInfo(held, info, Date.now())
    activeKey = result.set.key
    setHeld(result.sets, result.dropped)
    const have = haveOf(result.set)
    const before = have ? `, ${have}개는 전에 받아 둠` : ''
    setStatus(`받기 시작: ${setName(result.set)} (${info.count}조각${before})`)
    markUnseen()
  }

  // 트레이에서 멈춘 보내기를 '폐기': its kept pieces go too.
  function onCancel(ref) {
    const set = findSet(held, ref)
    if (!set) return
    if (activeKey === set.key) activeKey = null
    setHeld(removeSet(held, set.key))
    setStatus(`PC에서 폐기한 ${setName(set)} 받기를 지웠습니다`)
    notify(`PC에서 폐기한 ${setName(set)} 받기를 지웠습니다`)
  }

  // A payload too big for one frame comes in pieces (clipkey-send.ps1 splits it).
  function onPart(part) {
    const key = keyOf(part)
    lastPieceAt = Date.now()
    if (!part.wide && part.index === 0 && lastDone?.key === key) lastDone = null // older scripts: no info frame
    // Only while that send goes on (pieces a few seconds apart): sent again later, it is new.
    if (lastDone && lastDone.key === key && part.index > 0 && Date.now() - lastDone.at < SAME_SEND_MS) {
      lastDone = { key, at: Date.now() }
      setStatus(`이미 다 받은 내용의 조각 ${part.index + 1}/${part.count}: 건너뜁니다`)
      return
    }
    const result = addPiece(held, part, Date.now())
    activeKey = result.set ? result.set.key : null
    setHeld(result.sets, result.dropped)
    if (result.mixed) {
      failed('조각을 다 모았지만 내용이 맞지 않습니다(다른 내용의 조각이 섞임). 처음부터 다시 보내세요')
      return
    }
    if (result.payload) {
      lastDone = { key, at: Date.now() }
      onPayload(payloadEvent(result.payload))
      return
    }
    const missing = result.missing.length
      ? `. 빠진 조각 ${formatParts(result.missing)}: 다 보낸 뒤 PC 트레이의 '빠진 조각 다시 보내기'에 넣어 다시 보내세요`
      : ''
    setStatus(`${setName(result.set)} 조각 ${result.have}/${part.count}개 받음${missing}`)
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

  $('pcRxClearBtn').addEventListener('click', () => setItems([]))
  $('pcRxCmdCopy').addEventListener('click', () => copy($('pcRxCmd').textContent, '명령을 복사했습니다'))
  setItems([])
  renderHeld(held)
  if (held.length) setStatus(`중단된 받기 ${held.length}개가 있습니다. PC 트레이의 '이어 보내기'로 이어 받으세요`)

  return Object.freeze({
    onSecure,
    /** The link dropped: a half-received text is gone (the list stays). */
    reset() {
      rx = { ...rx, buffer: null }
      setChip(null)
      if (!$('pcRxStatus').textContent.startsWith('받는 중')) return
      const set = active()
      setStatus(
        set
          ? `연결이 끊겼습니다. ${setName(set)}의 조각 ${haveOf(set)}/${set.count}개는 '중단된 받기'에 보관했습니다. 다시 연결한 뒤 ${resumeHint(set)}`
          : '대기 중 (연결이 끊겨 받던 텍스트는 버렸습니다)',
      )
    },
  })
}

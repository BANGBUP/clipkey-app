// "받기" tab: text sent from the PC (clipkey-send.ps1) arrives here. Received texts stay in
// memory only (they may be passwords); just the auto-copy preference is saved.

import { SECURE_MSG } from './constants.js'
import { EMPTY_RX, reducePcRx } from './pcrx.js'

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

const timeLabel = (date) => date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/**
 * @param {{ notify: (msg: string) => void, toSendTab: (text: string) => void }} deps
 */
export function setupPcReceive({ notify, toSendTab }) {
  const $ = (id) => document.getElementById(id)
  const tab = document.querySelector('.tab[data-tab="receive"]')
  let rx = EMPTY_RX
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
    head.textContent = `${timeLabel(item.at)} · ${item.size}바이트`
    const text = document.createElement('pre')
    text.className = 'rx-text'
    text.textContent = item.text
    text.addEventListener('click', () => box.classList.toggle('expanded'))
    const actions = document.createElement('div')
    actions.className = 'row'
    const action = (label, run, extra = '') => {
      const b = document.createElement('button')
      b.className = `btn small ${extra}`
      b.textContent = label
      b.addEventListener('click', run)
      return b
    }
    actions.append(
      action('복사', () => copy(item.text)),
      action('보내기 탭으로', () => toSendTab(item.text)),
      action('삭제', () => setItems(items.filter((i) => i.id !== item.id)), 'danger'),
    )
    box.append(head, text, actions)
    return box
  }

  function setItems(next) {
    items = next
    $('pcRxList').replaceChildren(...items.map(itemView))
    $('pcRxEmpty').classList.toggle('hidden', items.length > 0)
  }

  async function received(text, size) {
    setItems([{ id: nextId++, text, size, at: new Date() }, ...items].slice(0, MAX_ITEMS))
    setStatus(`완료: ${size}바이트를 받았습니다`)
    markUnseen()
    if (autoCopy.checked) await copy(text, 'PC에서 텍스트를 받아 클립보드에 복사했습니다')
    else notify('PC에서 텍스트를 받았습니다')
  }

  function onSecure(msg) {
    if (msg.type !== SECURE_MSG.PC_RX && msg.type !== SECURE_MSG.PC_TEXT) return
    const result = reducePcRx(rx, msg)
    rx = result.rx
    const event = result.event
    if (!event) return
    if (event.type === 'progress') {
      setStatus(`받는 중 ${event.received}/${event.total} 바이트`, event)
      if (event.starting) {
        notify('PC에서 텍스트를 받는 중…')
        markUnseen()
      }
    } else if (event.type === 'done') {
      received(event.text, event.size)
    } else if (event.type === 'failed') {
      setStatus(`실패: ${event.reason}`)
      notify(`PC에서 받기 실패: ${event.reason}`)
      markUnseen()
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
      if ($('pcRxStatus').textContent.startsWith('받는 중')) setStatus('대기 중 (연결이 끊겨 받던 텍스트는 버렸습니다)')
    },
  })
}

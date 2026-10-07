// Under the send box: how many characters, and roughly how long typing them will take.

import { countKeys } from './keymap.js'

const OVERHEAD = 1.1 // Bluetooth / USB latency on top of the firmware's own waits

/**
 * Mirrors firmware/src/typer.c: every key report is followed by the key interval, a tap is
 * press + release, a 한/영 switch is one tap (Ctrl+Space on Apple: 4 reports) plus the
 * settle wait, and a jamo commit is at most two switches.
 * @param {{ taps: number, modeSwitches: number, commits: number }} count
 * @param {{ delayMs: number, settleMs: number, apple: boolean }} timing
 */
export function estimateTypingMs({ taps, modeSwitches, commits }, { delayMs, settleMs, apple }) {
  const tap = 2 * delayMs
  const toggle = (apple ? 4 : 2) * delayMs + settleMs
  return Math.round((taps * tap + modeSwitches * toggle + commits * 2 * toggle) * OVERHEAD)
}

/** "3초", "1분 20초", "1시간 5분" (rounded up so the estimate is not optimistic). */
export function formatDuration(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  if (seconds < 60) return `${seconds}초`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 ? `${minutes}분 ${seconds % 60}초` : `${minutes}분`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}시간 ${minutes % 60}분` : `${hours}시간`
}

/** One line of text for the stats label, or '' for an empty box. */
export function describeSend(count, timing) {
  if (count.chars === 0) return ''
  const parts = [`${count.chars.toLocaleString('ko-KR')}자`, `키 ${count.taps.toLocaleString('ko-KR')}번`]
  if (count.taps > 0) parts.push(`예상 약 ${formatDuration(estimateTypingMs(count, timing))}`)
  if (count.skipped > 0) parts.push(`입력 못 하는 문자 ${count.skipped}개는 건너뜀`)
  return parts.join(' · ')
}

/**
 * @param {{ textarea: HTMLTextAreaElement, out: HTMLElement,
 *           getTiming: () => { delayMs: number, settleMs: number, apple: boolean } }} deps
 * @returns {{ update: () => void }} call update() after setting the text from code, or when
 *          the key interval / target PC changes
 */
export function setupSendStats({ textarea, out, getTiming }) {
  let lastText = null
  let lastCount = null
  let timer = null

  function update() {
    const text = textarea.value
    if (text !== lastText) {
      lastText = text
      lastCount = countKeys(text)
    }
    out.textContent = describeSend(lastCount, getTiming())
  }

  // Counting a pasted novel on every keystroke is wasteful: settle first.
  textarea.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(update, 150)
  })
  update()
  return Object.freeze({ update })
}

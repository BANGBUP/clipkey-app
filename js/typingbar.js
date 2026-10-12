// The bar pinned to the bottom of the screen on every tab while text is being typed:
// "■ 중지" while the app is still sending AND afterwards, while the device works through its
// queue (up to 2048 keys, about a minute of Hangul). When a text was cut off (lost link,
// a call, the screen turned off) it offers "이어 보내기" for the part the device never got.

const MIN_ITEMS = 20 // single keys from the keyboard tab do not need a bar

/**
 * @param {{ bar: HTMLElement, progress: HTMLProgressElement, text: HTMLElement,
 *           button: HTMLButtonElement, onStop: () => void,
 *           resumeButton?: HTMLButtonElement, dropButton?: HTMLButtonElement,
 *           onResume?: (text: string) => void, onTyping?: (typing: boolean) => void }} els
 */
export function setupTypingBar({ bar, progress, text, button, onStop, resumeButton, dropButton, onResume, onTyping }) {
  let sending = { sent: 0, total: 0, active: false }
  let queueUsed = 0
  let remaining = '' // text cut off part-way, waiting for "이어 보내기"

  function label(showSending, showQueue) {
    if (showSending) return `보내는 중 ${sending.sent}/${sending.total}`
    const queue = showQueue ? `PC에 입력 중 · 남은 키 ${queueUsed.toLocaleString('ko-KR')}` : ''
    if (!remaining) return queue
    const cut = `끊김 · 못 보낸 글자 ${[...remaining].length.toLocaleString('ko-KR')}자`
    return queue ? `${cut} · ${queue}` : cut
  }

  function render() {
    const showSending = sending.active && sending.total >= MIN_ITEMS
    const showQueue = queueUsed >= MIN_ITEMS
    const typing = showSending || showQueue
    const showResume = Boolean(remaining) && !sending.active
    const show = typing || showResume
    bar.classList.toggle('hidden', !show)
    document.body.classList.toggle('typing', show)
    onTyping?.(sending.active || showQueue)
    if (!show) return
    progress.classList.toggle('hidden', !showSending)
    progress.max = Math.max(sending.total, 1)
    progress.value = sending.sent
    button.classList.toggle('hidden', !typing)
    resumeButton?.classList.toggle('hidden', !showResume)
    dropButton?.classList.toggle('hidden', !showResume)
    text.textContent = label(showSending, showQueue)
  }

  button.addEventListener('click', () => {
    button.disabled = true // one tap is enough; re-enabled when the bar comes back
    onStop()
    setTimeout(() => (button.disabled = false), 1000)
  })
  resumeButton?.addEventListener('click', () => {
    if (remaining) onResume?.(remaining)
  })
  dropButton?.addEventListener('click', () => {
    remaining = ''
    render()
  })

  return Object.freeze({
    /** From the sender: progress of handing the text to the device. */
    onSending(next) {
      sending = next
      render()
    },
    /** From STATUS: keys still waiting in the device (null when disconnected). */
    onStatus(status) {
      queueUsed = status?.queueUsed ?? 0
      render()
    },
    /** A text was cut off: `rest` never reached the device ('' = nothing left to offer). */
    setRemaining(rest) {
      remaining = rest ?? ''
      render()
    },
    get remaining() {
      return remaining
    },
  })
}

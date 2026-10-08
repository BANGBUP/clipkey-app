// The "■ 중지" bar pinned to the bottom of the screen on every tab while text is being typed:
// while the app is still sending AND afterwards, while the device works through its queue
// (up to 2048 keys, about a minute of Hangul), which used to have no stop button at all.

const MIN_ITEMS = 20 // single keys from the keyboard tab do not need a bar

/**
 * @param {{ bar: HTMLElement, progress: HTMLProgressElement, text: HTMLElement,
 *           button: HTMLButtonElement, onStop: () => void }} els
 */
export function setupTypingBar({ bar, progress, text, button, onStop }) {
  let sending = { sent: 0, total: 0, active: false }
  let queueUsed = 0

  function render() {
    const showSending = sending.active && sending.total >= MIN_ITEMS
    const show = showSending || queueUsed >= MIN_ITEMS
    bar.classList.toggle('hidden', !show)
    document.body.classList.toggle('typing', show)
    if (!show) return
    progress.classList.toggle('hidden', !showSending)
    progress.max = Math.max(sending.total, 1)
    progress.value = sending.sent
    text.textContent = showSending
      ? `보내는 중 ${sending.sent}/${sending.total}`
      : `PC에 입력 중 · 남은 키 ${queueUsed.toLocaleString('ko-KR')}`
  }

  button.addEventListener('click', () => {
    button.disabled = true // one tap is enough; re-enabled when the bar comes back
    onStop()
    setTimeout(() => (button.disabled = false), 1000)
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
  })
}

// In-app replacements for confirm() / prompt(). Some iOS Web BLE browsers (Bluefy) draw the
// native ones themselves with mislabeled buttons ("확인" shows as "앱 소개"), so every question
// the app asks goes through one <dialog> it styles and labels itself.

let dialog = null

function build() {
  const el = document.createElement('dialog')
  el.className = 'dialog'
  el.innerHTML = `
    <form method="dialog">
      <p class="modal-message"></p>
      <input class="text-input modal-input" autocomplete="off">
      <div class="row">
        <button value="ok" class="btn primary grow order-last modal-ok"></button>
        <button value="cancel" class="btn grow modal-cancel"></button>
      </div>
    </form>`
  document.body.append(el)
  return el
}

function open({ message, input, okText, cancelText }) {
  dialog ??= build()
  const field = dialog.querySelector('.modal-input')
  // textContent keeps line breaks as text; CSS white-space shows them
  dialog.querySelector('.modal-message').textContent = message
  dialog.querySelector('.modal-ok').textContent = okText
  dialog.querySelector('.modal-cancel').textContent = cancelText
  field.classList.toggle('hidden', input === null)
  field.value = input ?? ''
  dialog.returnValue = ''
  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => resolve(dialog.returnValue === 'ok' ? field.value : null),
      { once: true },
    )
    dialog.showModal()
    if (input !== null) field.focus()
  })
}

/** Resolves true for 확인, false for 취소 (or Esc / tapping outside). */
export async function askConfirm(message, { okText = '확인', cancelText = '취소' } = {}) {
  return (await open({ message, input: null, okText, cancelText })) !== null
}

/** Resolves the entered text, or null when cancelled. */
export function askText(message, initial = '', { okText = '확인', cancelText = '취소' } = {}) {
  return open({ message, input: initial ?? '', okText, cancelText })
}

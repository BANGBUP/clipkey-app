// Bluetooth PC pairing, driven from the phone (the device has no screen or buttons for it).
// The phone opens a 60 s window for one PC; the PIN check happens here.

import { PAIR_ACTION, SECURE_MSG } from './constants.js'
import { encodePcPairing, encodePcPairReply, formatPasskey } from './protocol.js'

const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

/**
 * @param {{ client, notify: (msg: string) => void }} deps
 */
export function setupPcPairing({ client, notify }) {
  const $ = (id) => document.getElementById(id)
  const dialog = $('pcPairDialog')
  const body = $('pcPairBody')
  const actions = $('pcPairActions')
  let active = false // the user started pairing from this screen
  let sawOpen = false // ignore a DONE/FAILED left over from an earlier attempt until the window opened
  let lastIdleState = null // to announce a refused pairing attempt once
  let promptPasskey = 0 // the PIN arrives only over the encrypted SECURE channel
  let promptState = PAIR_ACTION.NONE // which prompt that PIN belongs to
  let lastStatus = null
  let shownPrompt = '' // avoids re-rendering (and wiping input) on every status update

  const send = (frame) => client.send(frame).catch((e) => notify(`전송 실패: ${e.message}`))

  function close(message) {
    active = false
    shownPrompt = ''
    if (dialog.open) dialog.close()
    if (message) notify(message)
  }

  function cancel() {
    send(encodePcPairing(false))
    close('PC 연결을 취소했습니다')
  }

  function render(nodes, buttons) {
    body.replaceChildren(...nodes)
    actions.replaceChildren(...buttons)
  }

  const cancelBtn = () => el('button', { className: 'btn grow', textContent: '취소', onclick: cancel })

  function showWaiting() {
    render(
      [
        el('p', { textContent: '60초 안에 PC에서 연결하세요:' }),
        el('ol', {}, [
          el('li', { textContent: 'Windows 설정 → Bluetooth 및 장치 → 장치 추가 → Bluetooth' }),
          el('li', { textContent: '목록에서 ClipKey 선택' }),
          el('li', { textContent: 'PIN이 나오면 이 화면의 안내를 따르세요' }),
        ]),
      ],
      [cancelBtn()],
    )
  }

  function showNumericCompare(passkey) {
    const reply = (accept) => () => {
      send(encodePcPairReply({ accept }))
      if (!accept) close('불일치로 거부했습니다')
    }
    render(
      [
        el('p', { textContent: 'PC 화면의 PIN이 아래 숫자와 같으면 승인하세요. (PC에서도 "예/연결"을 누르세요)' }),
        el('div', { className: 'pin', textContent: formatPasskey(passkey) }),
      ],
      [
        el('button', { className: 'btn danger grow', textContent: '다름 (거부)', onclick: reply(false) }),
        el('button', { className: 'btn primary grow', textContent: '같음 (승인)', onclick: reply(true) }),
      ],
    )
  }

  function showDisplay(passkey) {
    render(
      [
        el('p', { textContent: 'PC에서 이 PIN을 입력하고 Enter를 누르세요:' }),
        el('div', { className: 'pin', textContent: formatPasskey(passkey) }),
      ],
      [cancelBtn()],
    )
  }

  function showInput() {
    const input = el('input', {
      className: 'pin-input',
      type: 'text',
      inputMode: 'numeric',
      maxLength: 6,
      placeholder: '000000',
      autocomplete: 'off',
    })
    const submit = () => {
      if (!/^\d{6}$/.test(input.value)) return notify('PC에 표시된 6자리 숫자를 입력하세요')
      send(encodePcPairReply({ accept: true, passkey: Number(input.value) }))
    }
    render(
      [el('p', { textContent: 'PC 화면에 표시된 6자리 PIN을 입력하세요:' }), input],
      [cancelBtn(), el('button', { className: 'btn primary grow', textContent: '확인', onclick: submit })],
    )
    input.focus()
  }

  async function start() {
    if (!client.connected) return notify('먼저 기기에 연결하세요')
    try {
      await client.send(encodePcPairing(true))
    } catch (error) {
      return notify(`PC 연결 시작 실패: ${error.message}`)
    }
    active = true
    sawOpen = false
    promptPasskey = 0
    promptState = PAIR_ACTION.NONE
    shownPrompt = 'waiting'
    showWaiting()
    if (!dialog.open) dialog.showModal()
  }

  $('pcPairBtn').addEventListener('click', start)
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault() // back gesture = explicit cancel, so the device closes its window too
    cancel()
  })

  return Object.freeze({
    onSecure(msg) {
      if (msg.type !== SECURE_MSG.PAIR_PROMPT) return
      promptPasskey = msg.passkey
      promptState = msg.state
      if (lastStatus) this.render(lastStatus)
    },
    render(status) {
      lastStatus = status
      $('pcPairBtn').disabled = !status
      if (!active) {
        const state = status?.pairAction ?? null
        if (state === PAIR_ACTION.REJECTED_CLOSED && lastIdleState !== null && state !== lastIdleState) {
          notify('PC/태블릿의 블루투스 연결 시도를 거부했습니다. 설정 → "PC 블루투스 연결 추가"를 먼저 누른 뒤 다시 연결하세요')
        }
        lastIdleState = state
        return
      }
      if (!status) return close('기기 연결이 끊겨 PC 연결을 중단했습니다')
      if (status.pairingOpen) sawOpen = true
      if (!sawOpen) return
      if (status.pairAction === PAIR_ACTION.DONE) return close('PC 블루투스 연결 완료')
      if (status.pairAction === PAIR_ACTION.FAILED) return close('PC 연결에 실패했습니다. 다시 시도하세요')
      if (!status.pairingOpen && status.pairAction === PAIR_ACTION.NONE) return close('60초가 지나 PC 연결 대기를 끝냈습니다')

      // Never show a PIN (or an Accept button) until the encrypted prompt for this step arrived.
      const ready = promptState === status.pairAction
      const key = `${status.pairAction}:${ready}:${promptPasskey}`
      if (key === shownPrompt) return
      shownPrompt = key
      if (!ready) showWaiting()
      else if (status.pairAction === PAIR_ACTION.NUMCMP) showNumericCompare(promptPasskey)
      else if (status.pairAction === PAIR_ACTION.DISPLAY) showDisplay(promptPasskey)
      else if (status.pairAction === PAIR_ACTION.INPUT) showInput()
      else showWaiting()
    },
  })
}

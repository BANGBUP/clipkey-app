// UI wiring for the ClipKey web app.

import { createClient, isSupported } from './ble.js'
import { normalizeText, unsupportedChars } from './keymap.js'
import { createSender } from './sender.js'
import { setupLive } from './live.js'
import { setupUsbMode } from './usbmode.js'
import { setupPcPairing } from './pcpair.js'
import { setupHostsUi } from './hostsui.js'
import { setupNickname } from './nickname.js'
import { setupTarget } from './target.js'
import { createReconnector } from './reconnect.js'
import { tokenStore } from './auth.js'
import { TOGGLE_KEYS, KEEP_AWAKE_KEYS, DEFAULT_KEEP_AWAKE_KEY, HOST_PROFILE, PAIR_ACTION } from './constants.js'
import {
  encodeSetIme,
  encodeSetToggleKey,
  encodeSetDelay,
  encodeSetImeSettle,
  encodeSetKeepAwake,
  keepAwakeKeyId,
} from './protocol.js'

const $ = (id) => document.getElementById(id)
const SETTINGS_KEY = 'clipkey.settings.v1'
const DEFAULT_SETTINGS = Object.freeze({ toggleKey: 'lang1', delay: 15, appleDelay: 20, settle: 30 })

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
    const toggleKey = raw.toggleKey in TOGGLE_KEYS ? raw.toggleKey : DEFAULT_SETTINGS.toggleKey
    const inRange = (v, min, max) => Number.isInteger(v) && v >= min && v <= max
    const delay = inRange(raw.delay, 2, 40) ? raw.delay : DEFAULT_SETTINGS.delay
    const appleDelay = inRange(raw.appleDelay, 2, 40) ? raw.appleDelay : DEFAULT_SETTINGS.appleDelay
    const settle = inRange(raw.settle, 0, 500) ? raw.settle : DEFAULT_SETTINGS.settle
    return { toggleKey, delay, appleDelay, settle }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // storage unavailable: settings last for this session only
  }
}

let toastTimer = null
function notify(message) {
  const el = $('toast')
  el.textContent = message
  el.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000)
}

function setChip(name, text, state) {
  const chip = document.querySelector(`[data-chip="${name}"]`)
  chip.textContent = text
  chip.className = `chip ${state ?? ''}`
}

let settings = loadSettings()
let live = null
let usbMode = null
let pcPair = null
let hostsUi = null
let nickname = null
let userDisconnected = false // the user pressed 연결 끊기: don't auto-reconnect
let suppressNextReconnect = false // a disconnect we caused on purpose (re-register)
let lastPairAction = null
let lastHostKey = '' // pcConnected / profile / wired: refresh the paired list when it changes

// "회사 PC (ClipKey-0F22)" once the nickname is known, else just the device name.
function deviceLabel() {
  const name = client.deviceName || '기기'
  return nickname?.value ? `${nickname.value} (${name})` : name
}

// "입력 대상" on every tab: a label, or a selector when several PCs are connected.
let target = null
const renderTarget = (status) => target?.render(status)

function renderStatus(status) {
  const connected = Boolean(status)
  setChip('link', connected ? `${deviceLabel()} 연결됨` : '기기 미연결', connected ? 'on' : 'bad')
  $('connectBtn').textContent = connected ? '연결됨' : '연결'
  $('connectBtn').disabled = connected
  live?.setEnabled(connected)
  if (!connected) {
    setChip('pc', 'PC')
    setChip('ime', '한/영', 'chip-btn')
    $('imeChip').disabled = true
    setChip('caps', 'Caps')
    setChip('usb', 'USB')
    $('imeBelief').textContent = '-'
    renderKeepAwake(null)
    usbMode?.render(null)
    pcPair?.render(null)
    hostsUi?.clear()
    hostsUi?.render()
    renderTarget(null)
    lastHostKey = ''
    return
  }
  const hostKind = status.hostProfile === HOST_PROFILE.APPLE ? ' (iPad/Mac)' : status.hostProfile ? ' (Windows)' : ''
  setChip('pc', status.pcConnected ? `PC 연결됨${hostKind}` : 'PC 미연결', status.pcConnected ? 'on' : 'warn')
  setChip('ime', status.imeHangul ? '한글 모드' : '영문 모드', 'on chip-btn')
  $('imeChip').disabled = false
  setChip('caps', 'Caps Lock', status.capsLock ? 'warn' : '')
  if (status.hostMode) {
    setChip('usb', status.usbKeyboard ? 'USB 키보드 연결됨' : 'USB 키보드 없음', status.usbKeyboard ? 'on' : '')
  } else {
    setChip('usb', status.usbPc ? '유선 PC 연결됨' : '유선 미연결', status.usbPc ? 'on' : '')
  }
  // Bluetooth-only chips (original ESP32) have no USB port features.
  document.querySelector('[data-chip="usb"]').classList.toggle('hidden', !status.usbOtg)
  $('imeBelief').textContent = status.imeHangul ? '한글' : '영문'
  renderKeepAwake(status)
  usbMode?.render(status)
  pcPair?.render(status)
  // A PC just paired, connected, disconnected or was identified: refresh the paired list.
  const hostKey = `${status.pcConnected}:${status.hostProfile}:${status.usbPc}:${status.activeConn}:${status.targetKind}`
  const paired = status.pairAction !== lastPairAction && status.pairAction === PAIR_ACTION.DONE
  if (paired || (lastHostKey && hostKey !== lastHostKey)) hostsUi?.refresh()
  lastHostKey = hostKey
  lastPairAction = status.pairAction
  renderTarget(status)
  if (status.pairingOpen) notify('기기가 등록 모드입니다')
}

const client = createClient({
  onStatus: renderStatus,
  onDisconnect: () => {
    nickname?.reset()
    renderStatus(null)
    usbMode?.onDisconnect()
    if (suppressNextReconnect) {
      suppressNextReconnect = false
      return
    }
    if (userDisconnected || !client.deviceId || !tokenStore.load(client.deviceId)) {
      notify('기기 연결이 끊겼습니다')
      return
    }
    if (reconnector.running) return // already retrying; one toast per outage
    notify('기기 연결이 끊겼습니다. 다시 연결하는 중…')
    reconnector.start().then((ok) => {
      if (ok) notify('다시 연결했습니다')
      else if (!userDisconnected) notify('자동 재연결 실패. "연결"을 눌러주세요')
    })
  },
  onSecure: (msg) => {
    pcPair?.onSecure(msg)
    hostsUi?.onSecure(msg)
    nickname?.onSecure(msg)
  },
})

// Silent reconnect while the page is open (device reboot, out of range, ...).
const reconnector = createReconnector({
  connect: async () => {
    await client.connect({ reuse: true })
    await pushSettings()
  },
  onAttemptFailed: () => client.disconnect(),
})

const sender = createSender(client, ({ sent, total, active }) => {
  const box = $('progressBox')
  box.classList.toggle('hidden', !active || total < 20)
  $('progress').max = Math.max(total, 1)
  $('progress').value = sent
  $('progressText').textContent = `${sent}/${total}`
})

async function pushSettings() {
  await client.send(encodeSetToggleKey(TOGGLE_KEYS[settings.toggleKey]))
  await client.send(encodeSetDelay(settings.delay, settings.appleDelay))
  await client.send(encodeSetImeSettle(settings.settle))
  hostsUi?.refresh()
}

// Asks for the device's setup code (only needed the first time this phone registers).
function askSetupCode() {
  const dialog = $('codeDialog')
  const input = $('codeInput')
  input.value = ''
  return new Promise((resolve) => {
    dialog.onclose = () => resolve(dialog.returnValue === 'ok' && /^\d{4,12}$/.test(input.value) ? input.value : null)
    dialog.returnValue = ''
    dialog.showModal()
    input.focus()
  })
}

async function connect(options = {}) {
  reconnector.stop() // a manual connect replaces any background retry
  userDisconnected = false
  try {
    const status = await client.connect({ reuse: client.hasDevice, getSetupCode: askSetupCode, ...options })
    await pushSettings()
    if (client.justRegistered) nickname?.askAfterRegister()
    if (!status.pcConnected) notify('기기에 연결했습니다. PC가 아직 연결되지 않았습니다(USB 케이블 또는 설정 → PC 블루투스 연결 추가)')
  } catch (error) {
    if (error.name === 'NotFoundError') return // chooser dismissed
    if (error.name === 'AbortError') {
      client.disconnect()
      return notify(error.message)
    }
    notify(error.message)
    client.disconnect()
  }
}

async function sendText(text) {
  if (!client.connected) {
    notify('먼저 기기에 연결하세요')
    return
  }
  if (!text) {
    notify('보낼 텍스트가 없습니다')
    return
  }
  try {
    const { skipped, completed } = await sender.sendText(text)
    const spaces = [...normalizeText(text)].filter((ch) => ch === ' ').length
    if (!completed) notify('취소했습니다')
    else if (skipped > 0) notify(`완료 · 띄어쓰기 ${spaces}개 · 건너뛴 문자 ${skipped}개: ${unsupportedChars(text).join(' ')}`)
    else notify(`타이핑 완료 · 띄어쓰기 ${spaces}개`)
  } catch (error) {
    notify(`전송 실패: ${error.message}`)
  }
}

async function readClipboard() {
  try {
    return await navigator.clipboard.readText()
  } catch (error) {
    notify(`클립보드를 읽을 수 없습니다: ${error.message}`)
    return ''
  }
}

function wireTabs() {
  document.querySelectorAll('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab))
      document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab.dataset.tab}`))
    }),
  )
}

function wireSend() {
  $('sendBtn').addEventListener('click', () => sendText($('sendText').value))
  $('clearBtn').addEventListener('click', () => ($('sendText').value = ''))
  $('pasteBtn').addEventListener('click', async () => {
    const text = await readClipboard()
    if (text) $('sendText').value = text
  })
  $('pasteSendBtn').addEventListener('click', async () => sendText(await readClipboard()))
  $('cancelBtn').addEventListener('click', () => sender.cancel().catch((e) => notify(e.message)))
}

// The device is the source of truth for keep-awake; the UI mirrors its status.
function renderKeepAwake(status) {
  const toggle = $('keepAwake')
  const minutes = $('keepAwakeMin')
  const keySelect = $('keepAwakeKey')
  ;[toggle, minutes, keySelect].forEach((el) => (el.disabled = !status))
  if (!status) return
  toggle.checked = status.keepAwakeSeconds > 0
  if (status.keepAwakeSeconds > 0 && document.activeElement !== minutes) {
    minutes.value = String(status.keepAwakeSeconds / 60)
  }
  const keyId = keepAwakeKeyId(status)
  if (keyId && document.activeElement !== keySelect) keySelect.value = keyId
}

function wireKeepAwake() {
  const toggle = $('keepAwake')
  const minutes = $('keepAwakeMin')
  const keySelect = $('keepAwakeKey')
  Object.entries(KEEP_AWAKE_KEYS).forEach(([id, { label }]) => keySelect.add(new Option(label, id)))
  keySelect.value = DEFAULT_KEEP_AWAKE_KEY

  const deviceIsOn = () => (client.status?.keepAwakeSeconds ?? 0) > 0
  const apply = () => {
    if (!client.connected) {
      toggle.checked = false
      return notify('먼저 기기에 연결하세요')
    }
    const value = Number(minutes.value)
    if (toggle.checked && !(value >= 0.5 && value <= 60)) {
      toggle.checked = deviceIsOn() // show what the device really does
      return notify('간격은 0.5~60분 사이로 입력하세요')
    }
    const tap = KEEP_AWAKE_KEYS[keySelect.value] ?? KEEP_AWAKE_KEYS[DEFAULT_KEEP_AWAKE_KEY]
    const seconds = toggle.checked ? Math.round(value * 60) : 0
    client
      .send(encodeSetKeepAwake(seconds, tap))
      .then(() => notify(seconds > 0 ? `화면보호기 방지 켜짐: ${value}분마다 ${tap.label}` : '화면보호기 방지 꺼짐'))
      .catch((e) => notify(`설정 실패: ${e.message}`))
  }
  toggle.addEventListener('change', apply)
  minutes.addEventListener('change', () => toggle.checked && apply())
  // The key is saved even while off, so it is ready when turned on.
  keySelect.addEventListener('change', apply)
}

function wireSettings() {
  const select = $('toggleKey')
  Object.entries(TOGGLE_KEYS).forEach(([value, { label }]) => select.add(new Option(label, value)))
  select.value = settings.toggleKey
  $('delay').value = settings.delay
  $('delayOut').textContent = settings.delay

  const apply = (patch) => {
    settings = { ...settings, ...patch }
    saveSettings(settings)
    if (client.connected) pushSettings().catch((e) => notify(e.message))
  }
  select.addEventListener('change', () => apply({ toggleKey: select.value }))
  $('delay').addEventListener('input', (e) => ($('delayOut').textContent = e.target.value))
  $('delay').addEventListener('change', (e) => apply({ delay: Number(e.target.value) }))
  $('appleDelay').value = settings.appleDelay
  $('appleDelayOut').textContent = settings.appleDelay
  $('appleDelay').addEventListener('input', (e) => ($('appleDelayOut').textContent = e.target.value))
  $('appleDelay').addEventListener('change', (e) => apply({ appleDelay: Number(e.target.value) }))
  $('settle').value = settings.settle
  $('settleOut').textContent = settings.settle
  $('settle').addEventListener('input', (e) => ($('settleOut').textContent = e.target.value))
  $('settle').addEventListener('change', (e) => apply({ settle: Number(e.target.value) }))

  const flipImeBelief = () => {
    const status = client.status
    if (!client.connected || !status) return notify('먼저 기기에 연결하세요')
    client
      .send(encodeSetIme(!status.imeHangul))
      .then(() => notify(`기기 기억을 ${status.imeHangul ? '영문' : '한글'}으로 맞췄습니다`))
      .catch((e) => notify(e.message))
  }
  $('imeChip').addEventListener('click', flipImeBelief)
  $('imeSyncBtn').addEventListener('click', flipImeBelief)
  $('reregisterBtn').addEventListener('click', () => {
    reconnector.stop()
    if (client.connected) {
      suppressNextReconnect = true // this disconnect must not start the auto-reconnect
      client.disconnect()
    }
    connect({ forceRegister: true })
  })
  $('disconnectBtn').addEventListener('click', () => {
    userDisconnected = true
    reconnector.stop()
    client.disconnect()
  })
}

function applyShareTarget() {
  const params = new URLSearchParams(location.search)
  const shared = [params.get('text'), params.get('url')].filter(Boolean).join('\n')
  if (!shared) return
  $('sendText').value = shared
  history.replaceState(null, '', location.pathname)
  notify('공유된 텍스트를 받았습니다. 연결 후 "PC로 타이핑"을 누르세요')
}

function init() {
  wireTabs()
  wireSend()
  wireSettings()
  wireKeepAwake()
  pcPair = setupPcPairing({ client, notify })
  usbMode = setupUsbMode({ client, notify })
  hostsUi = setupHostsUi({
    client,
    notify,
    onChange: () => renderTarget(client.status),
    onSelect: (host) => target?.selectHost(host),
  })
  target = setupTarget({ client, sender, notify, getHosts: () => hostsUi.hosts })
  nickname = setupNickname({ client, notify, onChange: () => client.status && renderStatus(client.status) })
  hostsUi.render()
  live = setupLive({
    field: $('liveText'),
    keypad: document.querySelector('.keypad'),
    resetBtn: $('liveReset'),
    composingToggle: $('liveComposing'),
    client,
    sender,
    notify,
  })
  renderStatus(null)
  applyShareTarget()
  $('connectBtn').addEventListener('click', () => connect())

  if (!isSupported()) {
    notify('이 브라우저는 Web Bluetooth를 지원하지 않습니다. 안드로이드 크롬에서 여세요')
    $('connectBtn').disabled = true
    return
  }
  client
    .reconnectKnown()
    .then((status) => status && pushSettings())
    .catch(() => undefined) // silent: user can press "연결"

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => undefined)
}

init()

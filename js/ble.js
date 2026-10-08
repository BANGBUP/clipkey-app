// Web Bluetooth client for the ClipKey device.

import { UUID, DEVICE_NAME, ATT_ERROR, FRAME, REGISTER_DEFAULT_CODE } from './constants.js'
import { parseStatus, parseAuthRead, encodeProve, encodeRegister } from './protocol.js'
import { tokenStore, createToken, proveToken } from './auth.js'
import { sealToken, deriveSessionKey, sealFrame, openDeviceFrame } from './crypto.js'
import { parseSecureMessage } from './hosts.js'
import { appLog, describeError } from './log.js'

const log = (m) => appLog.add(`[ble] ${m}`)

const STATUS_WAIT_MS = 1500
const GATT_RETRY_DELAY_MS = 700

// Older Web Bluetooth implementations (e.g. some iOS BLE browsers) only have writeValue(),
// which for our characteristics is a write with response too.
const writeWithResponse = (characteristic, value) =>
  typeof characteristic.writeValueWithResponse === 'function'
    ? characteristic.writeValueWithResponse(value)
    : characteristic.writeValue(value)
const GATT_STEP_TIMEOUT_MS = 15000

// Android's gatt.connect() can wait forever for a device that isn't there.
function withTimeout(promise, what) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DOMException(`${what} 시간 초과`, 'NetworkError')), GATT_STEP_TIMEOUT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Name first; the service UUID (in the scan response) as a second way to find a ClipKey.
const CHOOSER_OPTIONS = {
  filters: [{ namePrefix: DEVICE_NAME }, { services: [UUID.SERVICE] }],
  optionalServices: [UUID.SERVICE],
}

// Android often fails the first GATT step after a reconnect; those are worth one retry.
// Our own errors (wrong code, not registered, cancelled) are plain Errors and are not.
const isTransientGattError = (error) =>
  // Some iOS BLE browsers reject with a bare number instead of an Error.
  (typeof error === 'number' || typeof error === 'string') ||
  (typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    !['NotFoundError', 'SecurityError', 'NotAllowedError', 'AbortError'].includes(error.name))
const QUEUE_FULL_RETRIES = 20

// Chrome reports ATT application errors only inside the message text.
export function hasAttError(error, code) {
  const hex = code.toString(16)
  return new RegExp(`0x0*${hex}(?![0-9a-f])`, 'i').test(String(error?.message))
}

// "Queue full" (0x80) means the device refused the whole frame, so resending cannot type
// anything twice. Android Chrome often reports application errors only as a code-less
// "GATT Error Unknown." (NotSupportedError); a lost link reports NetworkError instead.
export function mayBeQueueFull(error) {
  if (hasAttError(error, ATT_ERROR.QUEUE_FULL)) return true
  const message = String(error?.message)
  return error?.name === 'NotSupportedError' && /unknown/i.test(message) && !/0x[0-9a-f]+/i.test(message)
}

// The device rejects AUTH writes with application ATT errors (0x80..0x9f). Anything else is a
// link problem and must stay a DOMException so the connect retry can handle it.
export const isDeviceRejection = (error) => /0x0*(8[0-9a-f]|9[0-9a-f])(?![0-9a-f])/i.test(String(error?.message))

const BOOT_HINT = '기기의 BOOT 버튼을 짧게 한 번 누른 뒤 60초 안에 다시 연결하세요(코드 없이 이 폰 1대 등록)'

// Firmware before BOOT registration: only an already registered phone can help.
const OLD_FIRMWARE_HINT =
  '이 ClipKey의 펌웨어가 오래되어 BOOT 버튼 등록을 지원하지 않습니다. 등록된 폰에서 펌웨어를 업데이트하거나, 그 폰에서 설정 코드를 정한 뒤 그 코드로 등록하세요'

function describeRegisterError(error, bootRegistration) {
  if (hasAttError(error, ATT_ERROR.NO_SETUP_CODE)) {
    return bootRegistration ? `이 ClipKey에는 설정 코드가 없습니다. ${BOOT_HINT}` : OLD_FIRMWARE_HINT
  }
  const boot = bootRegistration ? ` 코드를 모르면 ${BOOT_HINT}` : ''
  if (hasAttError(error, ATT_ERROR.LOCKED)) return `틀린 코드가 반복되어 등록이 잠겼습니다. 잠시 후 다시 시도하세요.${boot}`
  return `등록 실패: 설정 코드가 틀렸거나 등록이 잠겼습니다.${boot}`
}

/** getSetupCode may return this instead of a code: the user says BOOT was just pressed. */
export const USE_BOOT_WINDOW = Symbol('boot window')

export function isSupported() {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator
}

/**
 * @param {{ onStatus: (s) => void, onDisconnect: () => void, onSecure?: (msg) => void }} handlers
 */
export function createClient({ onStatus, onDisconnect, onSecure = () => {} }) {
  let device = null
  let chars = null
  let status = null
  let session = null // { key: CryptoKey, counter: number }
  let lastDeviceCounter = -1 // device -> phone replay guard
  let justRegistered = false // the last connect registered this phone (first use of this ClipKey)
  let registeredWithoutCode = false // ...and the ClipKey had no setup code stored then
  let bootRegistration = true // this ClipKey's firmware supports registering via the BOOT button
  let writeChain = Promise.resolve()
  const statusWaiters = new Set()

  // Before authentication the device reports only its caps byte: never shown as "connected".
  const publishStatus = () => {
    if (session) onStatus(status)
  }

  const handleStatus = (event) => {
    status = parseStatus(event.target.value)
    statusWaiters.forEach((resolve) => resolve(status))
    statusWaiters.clear()
    publishStatus()
  }

  // Encrypted device -> phone messages (PIN prompts, paired-device list).
  // Decrypt in arrival order so the replay counter never drops a genuine message.
  let secureChain = Promise.resolve()
  let secureSeen = 0 // per session, for the debug log
  let secureFailed = 0
  const handleSecure = (event) => {
    const v = event.target.value
    const bytes = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))
    if (secureSeen++ === 0) log(`first secure message (${bytes.length} bytes)`)
    secureChain = secureChain.then(async () => {
      if (!session) return
      try {
        const { counter, frame } = await openDeviceFrame(session.key, bytes)
        if (counter <= lastDeviceCounter) return // replayed
        lastDeviceCounter = counter
        onSecure(parseSecureMessage(frame))
      } catch (error) {
        // Tampered, stale or cut short (a link that never raised its MTU): ignored, but
        // said once so a silent app can be diagnosed.
        if (secureFailed++ < 3) log(`secure message ignored (${bytes.length} bytes): ${error?.message ?? error}`)
      }
    })
  }

  const handleDisconnect = (event) => {
    if (event && event.target !== device) return // a device we already switched away from
    const wasConnected = session !== null
    log(`disconnected (wasConnected=${wasConnected})`)
    chars = null
    status = null
    session = null
    statusWaiters.forEach((resolve) => resolve(null))
    statusWaiters.clear()
    onDisconnect({ wasConnected })
  }

  // Web Bluetooth rejects overlapping GATT operations, so every op goes through one chain.
  const serialize = (fn) => {
    const run = writeChain.then(fn, fn)
    writeChain = run.catch(() => undefined)
    return run
  }

  // Resolves with the next notified status, or undefined after the timeout.
  const waitForStatus = (timeoutMs = STATUS_WAIT_MS) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        statusWaiters.delete(done)
        resolve(undefined)
      }, timeoutMs)
      const done = (s) => {
        clearTimeout(timer)
        resolve(s)
      }
      statusWaiters.add(done)
    })

  async function readStatus() {
    const view = await serialize(() => linkChars().status.readValue())
    status = parseStatus(view)
    publishStatus()
    return status
  }

  // During a connect the link can drop between steps (handleDisconnect clears `chars`).
  const linkChars = () => {
    if (!chars) throw new DOMException('블루투스 연결이 끊겼습니다', 'NetworkError')
    return chars
  }

  const readAuth = async () => parseAuthRead(await serialize(() => linkChars().auth.readValue()))

  async function register(code) {
    const { nonce, devicePub } = await readAuth()
    if (!devicePub) throw new Error('기기 펌웨어가 오래되었습니다. 펌웨어를 업데이트하세요')
    const token = createToken()
    const sealed = await sealToken({ devicePub, nonce, token, code })
    try {
      await serialize(() => writeWithResponse(linkChars().auth, encodeRegister(sealed)))
    } catch (error) {
      // Never retried: the code may have reached the device, and every wrong try counts
      // toward its lockout (Chrome does not always include the ATT code in the message).
      throw new Error(describeRegisterError(error, bootRegistration))
    }
    tokenStore.save(device.id, token)
    registeredThisConnect = true
    return { token, nonce }
  }

  async function prove(token) {
    const { nonce } = await readAuth()
    const hmac = await proveToken(token, nonce)
    try {
      await serialize(() => writeWithResponse(linkChars().auth, encodeProve(hmac)))
    } catch (error) {
      const hint = `인증 실패: 연결 문제이거나 이 폰이 기기에 등록되어 있지 않습니다. 계속되면 설정에서 다시 등록하세요 (${error.message})`
      // Proving is safe to retry (fresh nonce each time): keep link errors retryable.
      if (!isDeviceRejection(error) && error instanceof DOMException) throw new DOMException(hint, error.name)
      throw new Error(hint)
    }
    return { token, nonce }
  }

  // BOOT window open, or no code stored at all: register with the default code. Without the
  // window the device answers NO_SETUP_CODE before checking anything (no lockout count), and
  // older firmware still takes 0000 for its first phone.
  async function chooseRegisterCode(getSetupCode) {
    const before = await readStatus()
    registeredWithoutCode = before.noSetupCode
    bootRegistration = before.bootRegistration
    log(`auth: register (window=${before.regWindow} noCode=${before.noSetupCode} boot=${bootRegistration})`)
    if (before.regWindow || before.noSetupCode) return REGISTER_DEFAULT_CODE
    const code = await getSetupCode({ bootRegistration })
    if (code !== USE_BOOT_WINDOW) return code
    const now = await readStatus()
    if (!now.regWindow) throw new Error(`BOOT 버튼이 눌린 것을 확인하지 못했습니다. ${BOOT_HINT}`)
    return REGISTER_DEFAULT_CODE
  }

  async function authenticate(forceRegister, getSetupCode) {
    const stored = forceRegister ? null : tokenStore.load(device.id)
    if (stored) log('auth: prove with saved token')
    let creds
    justRegistered = !stored
    registeredWithoutCode = false
    if (stored) {
      creds = await prove(stored)
    } else {
      const code = await chooseRegisterCode(getSetupCode)
      if (!code) throw Object.assign(new Error('등록을 취소했습니다'), { name: 'AbortError' })
      creds = await register(code)
    }
    const { token, nonce } = creds
    session = { key: await deriveSessionKey(token, nonce), counter: 1 }
    lastDeviceCounter = -1
    secureSeen = 0
    secureFailed = 0
    // addEventListener, not the on... property: some iOS Web BLE browsers (Bluefy) only
    // deliver to listeners. Adding the same function twice is a no-op.
    linkChars().secure.addEventListener('characteristicvaluechanged', handleSecure)
    await serialize(() => linkChars().secure.startNotifications())
    const s = await readStatus()
    if (!s.authed) throw new Error('인증 실패')
    return s
  }

  /** getSetupCode: async () => string | null, asked only when this phone must register. */
  let connecting = null // the one connect in progress (overlapping GATT setups break Android)
  let registeredThisConnect = false // token already saved: a retry must not register again

  // Leaves no half-open link behind: the app must never think "disconnected" while the
  // phone still holds a GATT connection (the next connect would then fail with GATT errors).
  function dropLink() {
    log(`drop link (gatt connected=${Boolean(device?.gatt?.connected)})`)
    chars = null
    session = null
    status = null
    if (device?.gatt?.connected) device.gatt.disconnect()
  }

  async function connectOnce({ reuse, forceRegister, getSetupCode }) {
    if (!isSupported()) throw new Error('이 브라우저는 Web Bluetooth를 지원하지 않습니다 (안드로이드 크롬 사용)')
    if (!reuse || !device) useDevice(await navigator.bluetooth.requestDevice(CHOOSER_OPTIONS))
    registeredThisConnect = false
    for (let attempt = 1; ; attempt += 1) {
      try {
        log(`connect attempt ${attempt} to ${device.name ?? device.id} (forceRegister=${forceRegister})`)
        const result = await openLink(forceRegister && !registeredThisConnect, getSetupCode)
        log(`connected: pc=${result.pcConnected} target=${result.targetKind} ime=${result.imeHangul ? '가' : 'A'}`)
        return result
      } catch (error) {
        log(`attempt ${attempt} failed: ${describeError(error)} (retry=${attempt < 2 && isTransientGattError(error)})`)
        dropLink()
        if (attempt >= 2 || !isTransientGattError(error)) throw error
        await new Promise((r) => setTimeout(r, GATT_RETRY_DELAY_MS))
      }
    }
  }

  /**
   * One connect at a time. A plain reconnect joins one already running; a chooser connect or
   * a re-register waits for it to finish and then runs on its own. An already working link
   * is kept for plain reconnects.
   */
  async function connect({ reuse = false, forceRegister = false, getSetupCode = async () => null } = {}) {
    const plain = reuse && !forceRegister
    if (connecting) {
      if (plain) return connecting
      await connecting.catch(() => undefined)
    }
    if (plain && chars && session && device?.gatt?.connected) return status
    if (!connecting) {
      connecting = connectOnce({ reuse, forceRegister, getSetupCode }).finally(() => {
        connecting = null
      })
    }
    return connecting
  }

  async function openLink(forceRegister, getSetupCode) {
    if (device.gatt.connected) device.gatt.disconnect() // start from a clean link
    log('gatt.connect…')
    const server = await withTimeout(device.gatt.connect(), '연결')
    log('getPrimaryService…')
    const service = await withTimeout(server.getPrimaryService(UUID.SERVICE), '서비스 확인')
    if (!device.gatt.connected) throw new DOMException('블루투스 연결이 끊겼습니다', 'NetworkError')
    chars = {
      cmd: await service.getCharacteristic(UUID.CMD),
      status: await service.getCharacteristic(UUID.STATUS),
      auth: await service.getCharacteristic(UUID.AUTH),
      secure: await service.getCharacteristic(UUID.SECURE),
    }
    chars.status.addEventListener('characteristicvaluechanged', handleStatus)
    await linkChars().status.startNotifications()
    return authenticate(forceRegister, getSetupCode)
  }

  /**
   * Opens the device chooser. Must be called straight from the click (Chrome only allows
   * the chooser right after a user gesture): it first aborts any connect in progress.
   */
  async function chooseDevice() {
    if (!isSupported()) throw new Error('이 브라우저는 Web Bluetooth를 지원하지 않습니다 (안드로이드 크롬 사용)')
    log('chooser open')
    const picking = navigator.bluetooth.requestDevice(CHOOSER_OPTIONS) // before any await
    if (device?.gatt?.connected && !session) device.gatt.disconnect() // abandon a stuck attempt
    const picked = await picking
    log(`chooser picked ${picked.name ?? picked.id}`)
    useDevice(picked)
    return device
  }

  /** Reconnects to a previously permitted device without a chooser, if the browser allows it. */
  async function reconnectKnown() {
    if (!isSupported() || typeof navigator.bluetooth.getDevices !== 'function') {
      log('startup: auto-connect unavailable (this Chrome has no bluetooth.getDevices) - press 연결')
      return null
    }
    // Only a ClipKey this phone is registered with: registering needs the user.
    const devices = await navigator.bluetooth.getDevices()
    const known = devices.find((d) => d.name?.startsWith(DEVICE_NAME) && tokenStore.load(d.id))
    log(`startup: ${devices.length} permitted device(s), auto-connect to ${known?.name ?? 'none'}`)
    if (!known) return null
    useDevice(known)
    return connect({ reuse: true })
  }

  // Switches to another ClipKey. The old one's late disconnect event must not tear down the
  // new link, so its handler goes first and its session is ended here.
  function useDevice(next) {
    if (next === device) return
    if (device) {
      device.ongattserverdisconnected = null
      const hadSession = session !== null
      dropLink()
      if (hadSession) onDisconnect({ wasConnected: false }) // UI reset only, no auto-reconnect
    }
    device = next
    device.ongattserverdisconnected = handleDisconnect
  }

  function disconnect() {
    if (device?.gatt?.connected) device.gatt.disconnect()
  }

  /**
   * Ends the session for good: asks the ClipKey to drop the link from its side first
   * (Android can keep the radio link after the page disconnects, hiding the device from
   * the chooser), then disconnects locally. Old firmware just ignores the request.
   */
  async function leave() {
    if (chars && session) {
      const bye = send(Uint8Array.of(FRAME.BYE)).catch(() => undefined)
      await Promise.race([bye, new Promise((r) => setTimeout(r, 600))])
    }
    disconnect()
  }

  /** Encrypts and writes one CMD frame. The counter is taken inside the chain so writes stay ordered. */
  async function send(frame) {
    if (!chars || !session) throw new Error('연결되어 있지 않습니다')
    return serialize(async () => {
      if (!chars || !session) throw new Error('연결이 끊겼습니다')
      const counter = session.counter
      session = { ...session, counter: counter + 1 }
      const sealed = await sealFrame(session.key, counter, frame)
      return writeWithResponse(chars.cmd, sealed)
    })
  }

  /**
   * Like send(), but as a write without response: resolves once the frame is queued, so the
   * next one can follow right away (OTA streaming). Only when canStream.
   */
  async function sendNoResponse(frame) {
    if (!chars || !session) throw new Error('연결되어 있지 않습니다')
    return serialize(async () => {
      if (!chars || !session) throw new Error('연결이 끊겼습니다')
      const counter = session.counter
      session = { ...session, counter: counter + 1 }
      const sealed = await sealFrame(session.key, counter, frame)
      return chars.cmd.writeValueWithoutResponse(sealed)
    })
  }

  /** Sends a KEYS frame once the device queue has room for it, retrying if the device reports it full. */
  async function sendKeys(frame, isCancelled = () => false) {
    const needed = (frame.length - 1) / 2
    let retries = 0
    while (!isCancelled()) {
      if (!chars) throw new Error('연결이 끊겼습니다')
      if (status && status.queueFree >= needed) {
        status = { ...status, queueFree: status.queueFree - needed }
        try {
          return await send(frame)
        } catch (error) {
          // Only "queue full" means the frame was not taken. Anything else may have reached
          // the device already, and resending would type the keys twice.
          retries += 1
          if (!chars || !mayBeQueueFull(error) || retries > QUEUE_FULL_RETRIES) throw error
          await readStatus() // stale estimate: refresh and retry
          continue
        }
      }
      const next = await waitForStatus()
      if (next === undefined && chars) await readStatus()
    }
    return undefined
  }

  return Object.freeze({
    connect,
    leave,
    chooseDevice,
    reconnectKnown,
    disconnect,
    send,
    sendNoResponse,
    sendKeys,
    readStatus,
    get connected() {
      return Boolean(chars && session)
    },
    // Firmware that streams OTA data marks CMD as writable without response.
    get canStream() {
      return Boolean(chars?.cmd?.properties?.writeWithoutResponse && typeof chars.cmd.writeValueWithoutResponse === 'function')
    },
    get hasDevice() {
      return Boolean(device)
    },
    get deviceName() {
      return device?.name ?? ''
    },
    get deviceId() {
      return device?.id ?? null
    },
    get justRegistered() {
      return justRegistered
    },
    get registeredWithoutCode() {
      return justRegistered && registeredWithoutCode
    },
    get connecting() {
      return connecting !== null
    },
    get status() {
      return status
    },
  })
}

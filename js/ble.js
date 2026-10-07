// Web Bluetooth client for the ClipKey device.

import { UUID, DEVICE_NAME, ATT_ERROR } from './constants.js'
import { parseStatus, parseAuthRead, encodeProve, encodeRegister } from './protocol.js'
import { tokenStore, createToken, proveToken } from './auth.js'
import { sealToken, deriveSessionKey, sealFrame, openDeviceFrame } from './crypto.js'
import { parseSecureMessage } from './hosts.js'

const STATUS_WAIT_MS = 1500
const GATT_RETRY_DELAY_MS = 700

// Android often fails the first GATT step after a reconnect; those are worth one retry.
// Our own errors (wrong code, not registered, cancelled) are plain Errors and are not.
const isTransientGattError = (error) =>
  typeof DOMException !== 'undefined' &&
  error instanceof DOMException &&
  !['NotFoundError', 'SecurityError', 'NotAllowedError', 'AbortError'].includes(error.name)
const QUEUE_FULL_RETRIES = 20

// Chrome reports ATT application errors only inside the message text.
function hasAttError(error, code) {
  const hex = code.toString(16)
  return new RegExp(`0x0*${hex}(?![0-9a-f])`, 'i').test(String(error?.message))
}

// The device rejects AUTH writes with application ATT errors (0x80..0x9f). Anything else is a
// link problem and must stay a DOMException so the connect retry can handle it.
const isDeviceRejection = (error) => /0x0*(8[0-9a-f]|9[0-9a-f])(?![0-9a-f])/i.test(String(error?.message))

function describeRegisterError(error) {
  if (hasAttError(error, ATT_ERROR.LOCKED)) return '틀린 코드가 반복되어 등록이 잠시 잠겼습니다. 잠시 후 다시 시도하세요'
  return '등록 실패: 설정 코드가 틀렸거나, 틀린 시도가 반복되어 잠겼습니다'
}

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
  let writeChain = Promise.resolve()
  const statusWaiters = new Set()

  const handleStatus = (event) => {
    status = parseStatus(event.target.value)
    statusWaiters.forEach((resolve) => resolve(status))
    statusWaiters.clear()
    onStatus(status)
  }

  // Encrypted device -> phone messages (PIN prompts, paired-device list).
  // Decrypt in arrival order so the replay counter never drops a genuine message.
  let secureChain = Promise.resolve()
  const handleSecure = (event) => {
    const v = event.target.value
    const bytes = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))
    secureChain = secureChain.then(async () => {
      if (!session) return
      try {
        const { counter, frame } = await openDeviceFrame(session.key, bytes)
        if (counter <= lastDeviceCounter) return // replayed
        lastDeviceCounter = counter
        onSecure(parseSecureMessage(frame))
      } catch {
        // tampered or stale message: ignore
      }
    })
  }

  const handleDisconnect = () => {
    const wasConnected = session !== null
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
    onStatus(status)
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
      await serialize(() => linkChars().auth.writeValueWithResponse(encodeRegister(sealed)))
    } catch (error) {
      // Never retried: the code may have reached the device, and every wrong try counts
      // toward its lockout (Chrome does not always include the ATT code in the message).
      throw new Error(describeRegisterError(error))
    }
    tokenStore.save(device.id, token)
    registeredThisConnect = true
    return { token, nonce }
  }

  async function prove(token) {
    const { nonce } = await readAuth()
    const hmac = await proveToken(token, nonce)
    try {
      await serialize(() => linkChars().auth.writeValueWithResponse(encodeProve(hmac)))
    } catch (error) {
      const hint = `인증 실패: 연결 문제이거나 이 폰이 기기에 등록되어 있지 않습니다. 계속되면 설정에서 다시 등록하세요 (${error.message})`
      // Proving is safe to retry (fresh nonce each time): keep link errors retryable.
      if (!isDeviceRejection(error) && error instanceof DOMException) throw new DOMException(hint, error.name)
      throw new Error(hint)
    }
    return { token, nonce }
  }

  async function authenticate(forceRegister, getSetupCode) {
    const stored = forceRegister ? null : tokenStore.load(device.id)
    let creds
    justRegistered = !stored
    if (stored) {
      creds = await prove(stored)
    } else {
      const code = await getSetupCode()
      if (!code) throw Object.assign(new Error('등록을 취소했습니다'), { name: 'AbortError' })
      creds = await register(code)
    }
    const { token, nonce } = creds
    session = { key: await deriveSessionKey(token, nonce), counter: 1 }
    lastDeviceCounter = -1
    linkChars().secure.oncharacteristicvaluechanged = handleSecure
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
    chars = null
    session = null
    status = null
    if (device?.gatt?.connected) device.gatt.disconnect()
  }

  async function connectOnce({ reuse, forceRegister, getSetupCode }) {
    if (!isSupported()) throw new Error('이 브라우저는 Web Bluetooth를 지원하지 않습니다 (안드로이드 크롬 사용)')
    if (!reuse || !device) {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: DEVICE_NAME }],
        optionalServices: [UUID.SERVICE],
      })
      device.ongattserverdisconnected = handleDisconnect
    }
    registeredThisConnect = false
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await openLink(forceRegister && !registeredThisConnect, getSetupCode)
      } catch (error) {
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
    const server = await device.gatt.connect()
    const service = await server.getPrimaryService(UUID.SERVICE)
    if (!device.gatt.connected) throw new DOMException('블루투스 연결이 끊겼습니다', 'NetworkError')
    chars = {
      cmd: await service.getCharacteristic(UUID.CMD),
      status: await service.getCharacteristic(UUID.STATUS),
      auth: await service.getCharacteristic(UUID.AUTH),
      secure: await service.getCharacteristic(UUID.SECURE),
    }
    chars.status.oncharacteristicvaluechanged = handleStatus
    await linkChars().status.startNotifications()
    return authenticate(forceRegister, getSetupCode)
  }

  /** Reconnects to a previously permitted device without a chooser, if the browser allows it. */
  async function reconnectKnown() {
    if (!isSupported() || typeof navigator.bluetooth.getDevices !== 'function') return null
    // Only a ClipKey this phone is registered with: registering needs the user.
    const known = (await navigator.bluetooth.getDevices()).find(
      (d) => d.name?.startsWith(DEVICE_NAME) && tokenStore.load(d.id),
    )
    if (!known) return null
    device = known
    device.ongattserverdisconnected = handleDisconnect
    return connect({ reuse: true })
  }

  function disconnect() {
    if (device?.gatt?.connected) device.gatt.disconnect()
  }

  /** Encrypts and writes one CMD frame. The counter is taken inside the chain so writes stay ordered. */
  async function send(frame) {
    if (!chars || !session) throw new Error('연결되어 있지 않습니다')
    return serialize(async () => {
      if (!chars || !session) throw new Error('연결이 끊겼습니다')
      const counter = session.counter
      session = { ...session, counter: counter + 1 }
      const sealed = await sealFrame(session.key, counter, frame)
      return chars.cmd.writeValueWithResponse(sealed)
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
          retries += 1
          if (!chars || retries > QUEUE_FULL_RETRIES) throw error
          await readStatus() // likely queue full on a stale estimate: refresh and retry
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
    reconnectKnown,
    disconnect,
    send,
    sendKeys,
    readStatus,
    get connected() {
      return Boolean(chars && session)
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
    get connecting() {
      return connecting !== null
    },
    get status() {
      return status
    },
  })
}

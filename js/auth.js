// Phone-side credential: a random 16-byte token registered once with the device.
// It is delivered sealed with ECDH (see crypto.js); each connection then proves possession
// with HMAC-SHA256(token, nonce) instead of sending it.

const LEGACY_KEY = 'clipkey.token.v1' // one token for one device (before multi-device support)
const STORAGE_KEY = 'clipkey.tokens.v2' // { [Web Bluetooth device.id]: hex token }

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
const fromHex = (hex) => Uint8Array.from(hex.match(/.{2}/g) ?? [], (h) => parseInt(h, 16))
const isTokenHex = (hex) => typeof hex === 'string' && /^[0-9a-f]{32}$/.test(hex)

export function createToken() {
  return crypto.getRandomValues(new Uint8Array(16))
}

/** Token storage keyed by device, so one phone can use several ClipKeys. */
export function createTokenStore(storage) {
  const readMap = () => {
    try {
      const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}')
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  const writeMap = (map) => {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(map))
    } catch (error) {
      throw new Error(`토큰을 저장할 수 없습니다 (브라우저 저장소 차단?): ${error.message}`)
    }
  }

  // The pre-multi-device token belonged to the only ClipKey this phone knew.
  function migrateLegacy(deviceId, map) {
    let legacy = null
    try {
      legacy = storage.getItem(LEGACY_KEY)
    } catch {
      return map
    }
    if (!isTokenHex(legacy) || Object.keys(map).length > 0) return map
    const next = { ...map, [deviceId]: legacy }
    try {
      writeMap(next)
      storage.removeItem(LEGACY_KEY)
    } catch {
      // keep using it in memory for this session
    }
    return next
  }

  return Object.freeze({
    load(deviceId) {
      const map = migrateLegacy(deviceId, readMap())
      return isTokenHex(map[deviceId]) ? fromHex(map[deviceId]) : null
    },
    save(deviceId, token) {
      writeMap({ ...readMap(), [deviceId]: toHex(token) })
    },
    forget(deviceId) {
      const { [deviceId]: _removed, ...rest } = readMap()
      try {
        writeMap(rest)
      } catch {
        // storage unavailable: nothing to forget
      }
    },
  })
}

const browserStorage = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
  removeItem: (k) => localStorage.removeItem(k),
}
export const tokenStore = createTokenStore(browserStorage)

export async function proveToken(token, nonce) {
  const key = await crypto.subtle.importKey('raw', token, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, nonce)
  return new Uint8Array(sig)
}

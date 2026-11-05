// Phone-side credential: a random 16-byte token registered once with the device.
// It is delivered sealed with ECDH (see crypto.js); each connection then proves possession
// with HMAC-SHA256(token, nonce) instead of sending it.

const LEGACY_KEY = 'clipkey.token.v1' // one token for one device (before multi-device support)
const STORAGE_KEY = 'clipkey.tokens.v2' // { [Web Bluetooth device.id]: hex token }
// { [device.id]: advertised name } of the same entries. Chrome sometimes hands out a new
// device.id for the same ClipKey (e.g. after a day), so the name helps find its token again.
const NAMES_KEY = 'clipkey.tokennames.v1'
const MAX_CANDIDATES = 2 // the device drops the link after 3 failed proofs

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

  const readNames = () => {
    try {
      const parsed = JSON.parse(storage.getItem(NAMES_KEY) ?? '{}')
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  const writeNames = (names) => {
    try {
      storage.setItem(NAMES_KEY, JSON.stringify(names))
    } catch {
      // only a lookup hint
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
    save(deviceId, token, name = null) {
      writeMap({ ...readMap(), [deviceId]: toHex(token) })
      if (name) writeNames({ ...readNames(), [deviceId]: name })
    },
    forget(deviceId) {
      const { [deviceId]: _removed, ...rest } = readMap()
      const { [deviceId]: _name, ...names } = readNames()
      try {
        writeMap(rest)
      } catch {
        // storage unavailable: nothing to forget
      }
      writeNames(names)
    },
    /**
     * Tokens saved under other device ids that may belong to this ClipKey (its id changed):
     * same advertised name first, then unnamed ones (saved before names were kept). A token
     * saved for a differently named ClipKey is never offered to this one.
     * At most MAX_CANDIDATES: [{ id, token }].
     */
    candidates(deviceId, name) {
      const map = readMap()
      const names = readNames()
      const rank = (id) => (name && names[id] === name ? 0 : 1)
      return Object.keys(map)
        .filter((id) => id !== deviceId && isTokenHex(map[id]) && (!names[id] || (name && names[id] === name)))
        .sort((a, b) => rank(a) - rank(b))
        .slice(0, MAX_CANDIDATES)
        .map((id) => ({ id, token: fromHex(map[id]) }))
    },
    /** A candidate proved itself: keep it under the new id only. */
    moveTo(oldId, newId, name = null) {
      const map = readMap()
      if (!isTokenHex(map[oldId])) return
      const { [oldId]: hex, ...rest } = map
      writeMap({ ...rest, [newId]: hex })
      const { [oldId]: _old, ...names } = readNames()
      writeNames(name ? { ...names, [newId]: name } : names)
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

// Link-layer protection for the phone <-> device channel (the phone is deliberately
// not BLE-bonded, so the BLE link itself is unencrypted).
//
// Registration: ECDH P-256 with the device's key, token sealed with AES-128-GCM,
//   key = SHA-256(shared_x || "clipkey-register" || nonce || setup_code_utf8)[0..16].
//   Only someone who knows the device's setup code can produce a token it accepts.
// Session:      key = HMAC-SHA256(token, "clipkey-session" || nonce)[0..16];
//   each CMD write = [counter u32 LE][AES-GCM(frame) + 16-byte tag], iv = counter LE || 8 zero bytes.
// Must match firmware/src/link_crypto.c.

const ECDH = { name: 'ECDH', namedCurve: 'P-256' }
const REGISTER_LABEL = new TextEncoder().encode('clipkey-register')
const SESSION_LABEL = new TextEncoder().encode('clipkey-session')

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  parts.reduce((offset, p) => {
    out.set(p, offset)
    return offset + p.length
  }, 0)
  return out
}

const aesKey = (raw) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])

export async function registerKeyFromShared(shared, nonce, code) {
  const material = concat(shared, REGISTER_LABEL, nonce, new TextEncoder().encode(String(code)))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', material))
  return aesKey(digest.slice(0, 16))
}

/** @returns {Promise<{ phonePub: Uint8Array, iv: Uint8Array, sealed: Uint8Array }>} */
export async function sealToken({ devicePub, nonce, token, code }) {
  const phone = await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])
  const deviceKey = await crypto.subtle.importKey('raw', devicePub, ECDH, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: deviceKey }, phone.privateKey, 256))
  const key = await registerKeyFromShared(shared, nonce, code)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, token))
  const phonePub = new Uint8Array(await crypto.subtle.exportKey('raw', phone.publicKey))
  return { phonePub, iv, sealed }
}

export async function deriveSessionKey(token, nonce) {
  const hmacKey = await crypto.subtle.importKey('raw', token, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, concat(SESSION_LABEL, nonce)))
  return aesKey(mac.slice(0, 16))
}

export function ivFromCounter(counter) {
  const iv = new Uint8Array(12)
  new DataView(iv.buffer).setUint32(0, counter >>> 0, true)
  return iv
}

export async function sealFrame(key, counter, frame) {
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivFromCounter(counter) }, key, frame))
  const header = new Uint8Array(4)
  new DataView(header.buffer).setUint32(0, counter >>> 0, true)
  return concat(header, ct)
}

/** Inverse of sealFrame (the firmware does this; kept here for tests). */
export async function openFrame(key, sealed) {
  const counter = new DataView(sealed.buffer, sealed.byteOffset, 4).getUint32(0, true)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivFromCounter(counter) }, key, sealed.slice(4))
  return { counter, frame: new Uint8Array(plain) }
}

// Device -> phone notifications reuse the session key; their counters have the top bit set
// so the two directions can never produce the same IV.
export const DEVICE_COUNTER_BIT = 0x80000000

export async function openDeviceFrame(key, sealed) {
  const counter = new DataView(sealed.buffer, sealed.byteOffset, 4).getUint32(0, true)
  if ((counter & DEVICE_COUNTER_BIT) === 0) throw new Error('기기 방향 프레임이 아닙니다')
  const { frame } = await openFrame(key, sealed)
  return { counter: (counter & ~DEVICE_COUNTER_BIT) >>> 0, frame }
}

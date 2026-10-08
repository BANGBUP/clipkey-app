// Settings: firmware version and over-the-air update (latest from this site, or a .ckfw file).

import { SECURE_MSG, ATT_ERROR } from './constants.js'
import { hasAttError, isDeviceRejection } from './ble.js'
import {
  parseCkfw,
  encodeOtaBegin,
  encodeOtaData,
  encodeOtaEnd,
  encodeOtaAbort,
  chipName,
  compareVersions,
  OTA_CHUNK,
} from './firmware.js'
import { createOtaStream, StreamUnsupportedError } from './otastream.js'
import { appLog, describeError } from './log.js'

const MANIFEST_URL = 'firmware/manifest.json'
const CHUNK_RETRIES = 3
const BEGIN_TIMEOUT_MS = 30000
const END_TIMEOUT_MS = 120000 // the device re-reads and verifies the whole image
const STREAM_WINDOW = 16384 // unconfirmed bytes in flight (the device confirms every 4 KB)
const STREAM_STALL_MS = 2000 // no progress note for this long: resend from the last confirmed point
const STREAM_MAX_STALLS = 8
const RESULT_TEXT = ['', '거부됨 (서명·기기 종류·이전 버전 확인 실패)', '기기 오류']
const log = (m) => appLog.add(`[ota] ${m}`)

/** @param {{ client, notify: (msg: string) => void }} deps */
export function setupFirmwareUi({ client, notify }) {
  const $ = (id) => document.getElementById(id)
  let device = null // { version, chip } from DEVICE_INFO, or { version: null, chip, guessed: true }
  let guessTimer = null
  let running = false
  let cancelled = false
  let waiting = null // { phase, resolve } for the next OTA_RESULT
  let latest = null // { version, file } from the site manifest for this chip, once fetched
  let stream = null // the running fast upload, fed by OTA_PROGRESS notes

  function awaitResult(phase, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting = null
        reject(new Error('기기 응답 시간 초과'))
      }, timeoutMs)
      waiting = {
        phase,
        resolve: (result) => {
          clearTimeout(timer)
          waiting = null
          if (result === 0) resolve()
          else reject(new Error(RESULT_TEXT[result] ?? `결과 ${result}`))
        },
      }
    })
  }

  const updateAvailable = () => Boolean(device?.version && latest && compareVersions(latest.version, device.version) > 0)

  // Some iOS Web BLE browsers drop the device-info message that arrives while notifications are
  // being switched on. Without it the chip is still known from STATUS (USB-OTG = ESP32-S3), so
  // updating stays possible; only the current version is unknown.
  function guessDevice() {
    guessTimer = null
    if (device || !client.connected || !client.status) return
    device = { version: null, chip: client.status.usbOtg ? 1 : 0, guessed: true }
    log(`no device info received: assuming ${chipName(device.chip)}, version unknown`)
    renderInfo()
    refreshLatest()
  }

  function renderInfo() {
    let text = '-'
    if (device?.version) {
      const state = !latest ? '' : updateAvailable() ? ` · 새 버전 ${latest.version} 있음` : ' · 최신'
      text = `${device.version} (${chipName(device.chip ?? 0)})${state}`
    } else if (device?.guessed) {
      text = `버전 확인 불가 (${chipName(device.chip)})${latest ? ` · 배포 버전 ${latest.version}` : ''}`
    }
    $('fwInfo').textContent = text
    $('fwInfo').classList.toggle('update-available', updateAvailable())
    const usable = client.connected && device?.chip !== null && device?.chip !== undefined && !running
    $('fwCheckBtn').disabled = !usable
    $('fwCheckBtn').classList.toggle('primary', updateAvailable())
    $('fwCheckBtn').textContent = updateAvailable() ? `${latest.version}으로 업데이트` : '최신 버전으로 업데이트'
    $('fwFileBtn').disabled = !usable
  }

  async function fetchLatest() {
    const manifest = await (await fetch(MANIFEST_URL, { cache: 'no-store' })).json()
    return manifest[chipName(device.chip)] ?? null
  }

  // Look up the published version as soon as we know the device (silently when offline).
  async function refreshLatest() {
    if (device?.chip === null || device?.chip === undefined) return
    try {
      latest = await fetchLatest()
      log(`published firmware for ${chipName(device.chip)}: ${latest?.version ?? 'none'}`)
    } catch (error) {
      latest = null
      log(`firmware check failed: ${describeError(error)}`)
    }
    renderInfo()
  }

  function progress(sent, total, text) {
    $('fwProgress').classList.toggle('hidden', total === 0)
    $('fwBar').max = Math.max(total, 1)
    $('fwBar').value = sent
    $('fwText').textContent = text ?? `${Math.floor((sent / Math.max(total, 1)) * 100)}%`
  }

  // A DATA write whose response got lost may still have reached the device. Writes are
  // ordered, so if a resend is refused as out of order (OTA_OFFSET), the device already has
  // this chunk: carry on with the next one.
  async function sendWithRetry(frame, { isData = false } = {}) {
    let mayHaveLanded = false // an earlier try failed without the device refusing it
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await client.send(frame)
      } catch (error) {
        if (isData && mayHaveLanded && hasAttError(error, ATT_ERROR.OTA_OFFSET)) {
          log('chunk had already arrived (resend refused as out of order)')
          return undefined
        }
        mayHaveLanded ||= !isDeviceRejection(error) // a device refusal means nothing was written
        if (attempt >= CHUNK_RETRIES || !client.connected) throw error
        await new Promise((r) => setTimeout(r, 300))
      }
    }
  }

  // Fast path: chunks back to back, the device reports progress. Returns how much is done
  // (all of it, or 0 when this link cannot stream and the slow path must start over).
  async function streamData(image) {
    const total = image.length
    stream = createOtaStream({
      total,
      chunkSize: OTA_CHUNK,
      windowBytes: STREAM_WINDOW,
      stallMs: STREAM_STALL_MS,
      maxStalls: STREAM_MAX_STALLS,
      sendChunk: (offset, length) => client.sendNoResponse(encodeOtaData(offset, image.subarray(offset, offset + length))),
      onProgress: (confirmed) => progress(confirmed, total),
      isCancelled: () => cancelled,
    })
    try {
      await stream.run()
      log('streamed')
      return total
    } catch (error) {
      if (!(error instanceof StreamUnsupportedError)) throw error
      log(`streaming refused (${error.message}): slower mode`)
      return 0
    } finally {
      stream = null
    }
  }

  async function upload(pkg) {
    if (pkg.chip !== device.chip) throw new Error(`이 파일은 ${chipName(pkg.chip)}용입니다 (기기: ${chipName(device.chip)})`)
    running = true
    cancelled = false
    renderInfo()
    let wakeLock = null
    try {
      wakeLock = await navigator.wakeLock?.request('screen').catch(() => null)
      const total = pkg.image.length
      log(`begin ${pkg.version} ${total} bytes`)
      progress(0, total, '서명 확인 중…')
      const begun = awaitResult(1, BEGIN_TIMEOUT_MS)
      await sendWithRetry(encodeOtaBegin(pkg))
      await begun
      const started = Date.now()
      const from = client.canStream ? await streamData(pkg.image) : 0
      for (let offset = from; offset < total; offset += OTA_CHUNK) {
        if (cancelled) throw new Error('취소했습니다')
        await sendWithRetry(encodeOtaData(offset, pkg.image.subarray(offset, offset + OTA_CHUNK)), { isData: true })
        progress(Math.min(offset + OTA_CHUNK, total), total)
      }
      progress(total, total, '확인·설치 중…')
      const ended = awaitResult(2, END_TIMEOUT_MS)
      await sendWithRetry(encodeOtaEnd())
      await ended
      log(`done in ${Math.round((Date.now() - started) / 1000)} s`)
      notify(`펌웨어 ${pkg.version} 설치 완료. 기기가 재시작하고 자동으로 다시 연결합니다`)
    } catch (error) {
      log(`failed: ${describeError(error)}`)
      if (client.connected) client.send(encodeOtaAbort()).catch(() => undefined)
      throw error
    } finally {
      running = false
      wakeLock?.release?.().catch(() => undefined)
      progress(0, 0)
      renderInfo()
    }
  }

  async function run(getBytes) {
    if (running) return
    try {
      const pkg = parseCkfw(await getBytes())
      if (!confirm(`펌웨어 ${device.version ?? '(현재 버전 알 수 없음)'} → ${pkg.version} 으로 업데이트할까요?\n약 1~3분 걸립니다(휴대폰에 따라 다름). 그동안 앱을 닫거나 화면을 끄지 마세요.`)) return
      await upload(pkg)
    } catch (error) {
      notify(`펌웨어 업데이트 실패: ${error.message ?? error}`)
    }
  }

  $('fwCheckBtn').addEventListener('click', async () => {
    try {
      const entry = await fetchLatest()
      latest = entry
      renderInfo()
      if (!entry) return notify('이 기기용 배포 펌웨어가 아직 없습니다')
      if (device.version && compareVersions(entry.version, device.version) <= 0) return notify(`최신 버전입니다 (${device.version})`)
      await run(async () => new Uint8Array(await (await fetch(`firmware/${entry.file}`, { cache: 'no-store' })).arrayBuffer()))
    } catch (error) {
      notify(`최신 버전 확인 실패: ${error.message}`)
    }
  })
  $('fwFileBtn').addEventListener('click', () => $('fwFile').click())
  $('fwFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) run(async () => new Uint8Array(await file.arrayBuffer()))
  })
  $('fwCancelBtn').addEventListener('click', () => {
    cancelled = true
  })
  renderInfo()

  return Object.freeze({
    onSecure(msg) {
      if (msg.type === SECURE_MSG.OTA_PROGRESS) {
        stream?.onNote(msg)
        return
      }
      if (msg.type === SECURE_MSG.OTA_RESULT) {
        if (waiting?.phase === msg.phase) waiting.resolve(msg.result)
        return
      }
      if (msg.type !== SECURE_MSG.DEVICE_INFO) return
      clearTimeout(guessTimer)
      device = { version: msg.version, chip: msg.chip }
      renderInfo()
      refreshLatest()
    },
    reset() {
      clearTimeout(guessTimer)
      guessTimer = null
      device = null
      latest = null
      renderInfo()
    },
    /** Each STATUS while connected: waits a moment for DEVICE_INFO, then guesses. */
    onStatus() {
      if (!device && !guessTimer && client.connected) guessTimer = setTimeout(guessDevice, 3000)
    },
    get running() {
      return running
    },
  })
}

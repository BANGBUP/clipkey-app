// "상태 보고하기": sends the phone number, the symptom, versions and the app log to the
// administrator's Google Sheet (scripts/report/Code.gs, deployed as an Apps Script web app).
// The log never holds what was typed (only lengths), see sendText in app.js.

import { REPORT_URL } from './config.js'

export const SYMPTOM_MAX = 2000
export const LOG_MAX = 300_000 // characters; the newest part is kept
const PHONE_KEY = 'clipkey.report.phone'

/** Korean phone numbers: 0 + 8..10 digits, dashes and spaces allowed. '' when invalid. */
export function normalizePhone(input) {
  const digits = String(input ?? '').replace(/[\s-]/g, '')
  return /^0\d{8,10}$/.test(digits) ? digits : ''
}

/**
 * @param {{ phone: string, symptom: string, log: string, context: object }} input
 * @returns {object} the JSON body Code.gs expects
 */
export function buildReport({ phone, symptom, log, context }) {
  const text = String(log ?? '')
  return {
    v: 1,
    phone,
    symptom: String(symptom ?? '').trim().slice(0, SYMPTOM_MAX),
    ...context,
    logTruncated: text.length > LOG_MAX,
    log: text.length > LOG_MAX ? text.slice(-LOG_MAX) : text,
  }
}

/**
 * text/plain keeps it a "simple" request (no CORS preflight, which Apps Script cannot answer).
 * @returns {Promise<string>} the report id from the sheet
 */
export async function sendReport(report, { url = REPORT_URL, fetchImpl = globalThis.fetch } = {}) {
  if (!url) throw new Error('보고를 받을 주소가 아직 설정되지 않았습니다. 관리자에게 문의하세요')
  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(report),
      redirect: 'follow',
    })
  } catch {
    throw new Error('보고를 보내지 못했습니다. 인터넷 연결을 확인하세요')
  }
  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.ok) throw new Error(`보고를 받지 못했습니다${result?.error ? ` (${result.error})` : ''}`)
  return String(result.id ?? '')
}

function loadPhone() {
  try {
    return localStorage.getItem(PHONE_KEY) ?? ''
  } catch {
    return ''
  }
}

function savePhone(phone) {
  try {
    localStorage.setItem(PHONE_KEY, phone)
  } catch {
    // storage unavailable: typed again next time
  }
}

/**
 * @param {{ $: (id: string) => HTMLElement, notify: (msg: string) => void,
 *           getLog: () => string, getContext: () => object, log: (line: string) => void }} deps
 */
export function setupReport({ $, notify, getLog, getContext, log }) {
  const phoneInput = $('reportPhone')
  const symptomInput = $('reportSymptom')
  const button = $('reportBtn')
  phoneInput.value = loadPhone()

  button.addEventListener('click', async () => {
    const phone = normalizePhone(phoneInput.value)
    if (!phone) {
      notify('연락받을 전화번호를 입력하세요 (예: 010-1234-5678)')
      phoneInput.focus()
      return
    }
    savePhone(phoneInput.value.trim())
    button.disabled = true
    try {
      const report = buildReport({ phone, symptom: symptomInput.value, log: getLog(), context: getContext() })
      const id = await sendReport(report)
      log(`report sent ${id}`)
      symptomInput.value = ''
      notify(`상태를 보고했습니다${id ? ` (접수 번호 ${id})` : ''}. 확인 후 연락드리겠습니다`)
    } catch (error) {
      notify(error.message)
    } finally {
      button.disabled = false
    }
  })
}

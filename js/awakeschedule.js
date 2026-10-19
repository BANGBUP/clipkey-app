// 화면보호기 방지 hours: only on the chosen days and time ranges (e.g. 9:00-12:00 and
// 13:00-18:00 on weekdays, so lunch and nights are left alone). Kept in the app and sent to
// the ClipKey on every connect together with the phone's clock (the device has none).
// Firmware 1.0.32+ (CAPS.AWAKE_SCHEDULE).

import { FRAME, AWAKE_FLAG } from './constants.js'

const STORAGE_KEY = 'clipkey.awakeSchedule'
export const RANGES_MAX = 4
const DAY_MIN = 1440
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토']

export const DEFAULT_SCHEDULE = Object.freeze({
  on: false,
  days: Object.freeze([1, 2, 3, 4, 5]), // 0 = Sunday, like Date.getDay()
  ranges: Object.freeze([
    Object.freeze({ start: 9 * 60, end: 12 * 60 }),
    Object.freeze({ start: 13 * 60, end: 18 * 60 }),
  ]),
})

const isMinute = (n) => Number.isInteger(n) && n >= 0 && n <= DAY_MIN

/** Drops anything malformed; returns a fresh, frozen schedule. */
export function validateSchedule(input) {
  const days = [...new Set((Array.isArray(input?.days) ? input.days : []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
  const ranges = (Array.isArray(input?.ranges) ? input.ranges : [])
    .filter((r) => isMinute(r?.start) && isMinute(r?.end) && r.end > r.start && r.start < DAY_MIN)
    .slice(0, RANGES_MAX)
    .map((r) => Object.freeze({ start: r.start, end: r.end }))
  return Object.freeze({ on: Boolean(input?.on), days: Object.freeze(days), ranges: Object.freeze(ranges) })
}

export function loadSchedule(storage = globalThis.localStorage) {
  try {
    const saved = storage?.getItem(STORAGE_KEY)
    return saved ? validateSchedule(JSON.parse(saved)) : DEFAULT_SCHEDULE
  } catch {
    return DEFAULT_SCHEDULE
  }
}

export function saveSchedule(schedule, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(schedule))
  } catch {
    // private mode: the device still keeps what was sent
  }
}

/** "09:30" <-> 570 */
export const minuteToText = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
export function textToMinute(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (!match) return null
  const [h, m] = [Number(match[1]), Number(match[2])]
  if (h === 24 && m === 0) return DAY_MIN
  return h < 24 && m < 60 ? h * 60 + m : null
}

/** [0x2A, on, days, count, (start, end u16 LE)*] */
export function encodeSetAwakeSchedule(schedule) {
  const s = validateSchedule(schedule)
  const days = s.days.reduce((mask, d) => mask | (1 << d), 0)
  const bytes = s.ranges.flatMap(({ start, end }) => [start & 0xff, start >> 8, end & 0xff, end >> 8])
  return Uint8Array.from([FRAME.SET_AWAKE_SCHEDULE, s.on ? 1 : 0, days, s.ranges.length, ...bytes])
}

/** The phone's local time as seconds since 1970-01-01 00:00 local: [0x29, u32 LE]. */
export function encodeSetClock(date = new Date()) {
  const local = Math.floor(date.getTime() / 1000) - date.getTimezoneOffset() * 60
  return Uint8Array.of(FRAME.SET_CLOCK, local & 0xff, (local >>> 8) & 0xff, (local >>> 16) & 0xff, (local >>> 24) & 0xff)
}

/** Frames to send on connect / change, when the firmware understands them. */
export const scheduleFrames = (schedule, status) =>
  status?.awakeSchedule ? [encodeSetClock(), encodeSetAwakeSchedule(schedule)] : []

/** One line for the settings screen. */
export function describeSchedule(schedule, status) {
  if (!schedule.on) return '하루 종일 작동'
  const days = schedule.days.length === 7 ? '매일' : schedule.days.map((d) => DAY_NAMES[d]).join('·') || '요일 없음'
  const hours = schedule.ranges.map((r) => `${minuteToText(r.start)}~${minuteToText(r.end)}`).join(', ') || '시간대 없음'
  const resting = status && (status.awakeFlags & AWAKE_FLAG.RESTING) !== 0
  return `${days} ${hours}${resting ? ' · 지금은 쉬는 중' : status?.keepAwakeSeconds ? ' · 지금 작동 중' : ''}`
}

const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

/**
 * @param {{ client, notify: (msg: string) => void }} deps
 */
export function setupAwakeSchedule({ client, notify }) {
  const $ = (id) => document.getElementById(id)
  const box = $('awakeSchedule')
  const toggle = $('awakeScheduleOn')
  const daysBox = $('awakeDays')
  const rangesBox = $('awakeRanges')
  const addBtn = $('awakeRangeAdd')
  const summary = $('awakeScheduleSummary')
  let schedule = loadSchedule()

  async function apply(next) {
    schedule = validateSchedule(next)
    saveSchedule(schedule)
    draw()
    if (!client.connected || !client.status?.awakeSchedule) return
    try {
      for (const frame of scheduleFrames(schedule, client.status)) await client.send(frame)
    } catch (error) {
      notify(`시간대 설정 실패: ${error.message}`)
    }
  }

  function dayButtons() {
    return DAY_NAMES.map((name, day) => {
      const on = schedule.days.includes(day)
      const button = el('button', { type: 'button', className: `day-btn${on ? ' on' : ''}`, textContent: name })
      button.setAttribute('aria-pressed', String(on))
      button.addEventListener('click', () =>
        apply({ ...schedule, days: on ? schedule.days.filter((d) => d !== day) : [...schedule.days, day] }),
      )
      return button
    })
  }

  function rangeRow(range, index) {
    const time = (value) => el('input', { type: 'time', value: minuteToText(value === DAY_MIN ? DAY_MIN - 1 : value), className: 'time-input' })
    const start = time(range.start)
    const end = time(range.end)
    const update = () => {
      const s = textToMinute(start.value)
      const e = textToMinute(end.value)
      if (s === null || e === null || e <= s) {
        notify('끝나는 시각은 시작보다 늦어야 합니다')
        draw()
        return
      }
      apply({ ...schedule, ranges: schedule.ranges.map((r, i) => (i === index ? { start: s, end: e } : r)) })
    }
    start.addEventListener('change', update)
    end.addEventListener('change', update)
    const remove = el('button', { type: 'button', className: 'btn small', textContent: '삭제' })
    remove.addEventListener('click', () => apply({ ...schedule, ranges: schedule.ranges.filter((_, i) => i !== index) }))
    return el('div', { className: 'row range-row' }, [start, el('span', { textContent: '~' }), end, remove])
  }

  function draw() {
    const status = client.status
    box.classList.toggle('hidden', !status?.awakeSchedule)
    toggle.checked = schedule.on
    daysBox.replaceChildren(...dayButtons())
    if (!rangesBox.contains(document.activeElement)) {
      rangesBox.replaceChildren(...schedule.ranges.map(rangeRow))
    }
    addBtn.disabled = schedule.ranges.length >= RANGES_MAX
    ;[daysBox, rangesBox, addBtn].forEach((node) => node.classList.toggle('dim', !schedule.on))
    summary.textContent = describeSchedule(schedule, status)
  }

  toggle.addEventListener('change', () => apply({ ...schedule, on: toggle.checked }))
  addBtn.addEventListener('click', () => {
    const last = schedule.ranges.at(-1)
    const start = last ? Math.min(last.end + 60, DAY_MIN - 60) : 9 * 60
    apply({ ...schedule, ranges: [...schedule.ranges, { start, end: start + 60 }] })
  })

  return Object.freeze({
    render: draw,
    /** On connect: the clock and the schedule, after the typing settings. */
    frames: () => scheduleFrames(schedule, client.status),
  })
}

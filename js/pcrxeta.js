// Time left of a send from the PC, from how fast it has come in so far (pauses between the
// pieces included, since the clock runs through them). A state is replaced, never changed.

/** Seconds of receiving before a guess is shown (the first moments say little). */
export const ETA_WARMUP_MS = 3_000

/** A new measure: `key` is the send's (null for a text in one frame). */
export function etaStart(key, now) {
  return Object.freeze({ key, startAt: now, doneBytes: 0, frameBytes: 0 })
}

/** A progress report of the frame coming in now; `starting`: a new frame began. */
export function etaProgress(state, { received, starting }) {
  const doneBytes = starting ? state.doneBytes + state.frameBytes : state.doneBytes
  return Object.freeze({ ...state, doneBytes, frameBytes: received })
}

/**
 * Milliseconds left, or null while too early to tell.
 * piecesAfter: whole pieces still to come after this frame (each about this frame's size).
 */
export function etaLeftMs(state, { received, total, piecesAfter = 0 }, now) {
  const elapsed = now - state.startAt
  const got = state.doneBytes + received
  if (elapsed < ETA_WARMUP_MS || got <= 0) return null
  const left = Math.max(0, total - received) + Math.max(0, piecesAfter) * total
  return (left * elapsed) / got
}

// Live-typing diff: given what the PC already has and what the phone field now shows,
// compute the minimal "backspace N, then type S" edit, assuming the PC caret sits at
// the end of the previously sent text.

export function diffText(previous, next) {
  const prev = [...previous]
  const curr = [...next]
  const max = Math.min(prev.length, curr.length)
  let common = 0
  while (common < max && prev[common] === curr[common]) common += 1
  return Object.freeze({
    backspaces: prev.length - common,
    insert: curr.slice(common).join(''),
  })
}

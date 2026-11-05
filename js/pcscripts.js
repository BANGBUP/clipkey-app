// "PC 필수 스크립트" on the 보내기 tab: the PC-side scripts (site tools/, cached for offline)
// typed into a PowerShell window on a PC that cannot download them. One tap types the save
// command, the script, then Ctrl+Z and Enter, so the file ends up in C:\temp.

import { OP, MOD, KEY } from './constants.js'
import { askConfirm } from './modal.js'

const DIR = 'C:\\temp'
const KEY_Z = 0x1d

export const PC_SCRIPTS = Object.freeze([
  { file: 'clipkey-recv.ps1', title: '받기 창', what: "폰의 '트레이로 압축 보내기'를 받아 텍스트·파일로 복원" },
  { file: 'clipkey-send.ps1', title: '보내기', what: 'PC 클립보드·파일을 폰 받기 탭으로 (표시등 신호)' },
  { file: 'clipkey-tray.ps1', title: '트레이', what: '알림 영역 아이콘: 보내기, 받기 창 열기 (위 둘과 같은 폴더에)' },
])

/** Typed first: makes the folder, then saves everything typed until Ctrl+Z. */
export const saveCommand = (file) =>
  `New-Item -ItemType Directory -Force ${DIR} | Out-Null; [Console]::In.ReadToEnd() | Set-Content -Encoding UTF8 ${DIR}\\${file}`

/** Save command, script and a final line break (Ctrl+Z must start a line). */
export function scriptTyping(file, script) {
  const body = script.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  return `${saveCommand(file)}\n${body}${body.endsWith('\n') ? '' : '\n'}`
}

const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

/**
 * @param {{ root: HTMLElement, typeText: (text: string) => Promise<boolean>,
 *           typeOps: (ops: object[]) => Promise<unknown>, estimate: (text: string) => string,
 *           packFile: (name: string, bytes: Uint8Array) => Promise<void>,
 *           notify: (m: string) => void }} deps  typeText resolves true when fully typed
 */
export function setupPcScripts({ root, typeText, typeOps, estimate, packFile, notify }) {
  // Bytes as published (with the UTF-8 BOM Windows PowerShell needs for 한글).
  async function fetchScript(file) {
    const res = await fetch(`tools/${file}`, { cache: 'no-cache' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  async function loadScript(file) {
    try {
      return await fetchScript(file)
    } catch (error) {
      notify(`${file}을 불러오지 못했습니다(${error.message}). 인터넷에 연결된 상태에서 앱을 한 번 열어 두세요`)
      return null
    }
  }

  async function packScript({ file }) {
    const bytes = await loadScript(file)
    if (bytes) await packFile(file, bytes)
  }

  async function sendScript({ file, title }) {
    const bytes = await loadScript(file)
    if (!bytes) return
    const text = scriptTyping(file, new TextDecoder().decode(bytes))
    const ok = await askConfirm(
      `${title} (${file})\n\nPC에서 PowerShell 창을 열어 앞에 두세요. 저장 명령, 스크립트 내용, 마지막 Ctrl+Z와 Enter까지 이어서 칩니다. 예상 약 ${estimate(text)}.\n끝나면 ${DIR}\\${file} 로 저장됩니다.`,
      { okText: '전송하기' },
    )
    if (!ok) return
    if (await typeText(text)) await typeOps([{ type: OP.TAP, mod: MOD.LCTRL, key: KEY_Z }, { type: OP.TAP, mod: 0, key: KEY.ENTER }])
  }

  const button = (text, title, onClick) => {
    const b = el('button', { className: 'btn small', textContent: text, title })
    b.addEventListener('click', onClick)
    return b
  }

  // One row per script: 타이핑 (PowerShell 창) | 압축 (받기 창, much faster)
  const row = (script) =>
    el('div', { className: 'row' }, [
      el('div', { className: 'grow' }, [
        el('strong', { textContent: script.title }),
        el('div', { className: 'hint', textContent: `${script.file} · ${script.what}` }),
      ]),
      el('div', { className: 'split-btns' }, [
        button('타이핑', 'PowerShell 창에 타이핑해서 저장', () => sendScript(script)),
        button('압축', `PC의 받기 창으로 압축해서 보냄 (${DIR}에 저장)`, () => packScript(script)),
      ]),
    ])

  root.replaceChildren(...PC_SCRIPTS.map(row))
}

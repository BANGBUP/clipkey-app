// Send tab extras: saved phrases ("자주 쓰는 문구", tap to type) and the recent-text history.
// Both live only on this phone (localStorage).

import { askConfirm } from './modal.js'
import {
  addToHistory,
  removeFromHistory,
  togglePin,
  clearUnpinned,
  upsertSnippet,
  removeSnippet,
  moveSnippet,
  createStore,
  validHistory,
  validSnippets,
  HISTORY_LIMIT,
} from './lists.js'

const browserStorage = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
}
const snippetStore = createStore(browserStorage, 'clipkey.snippets.v1', [], validSnippets)
const historyStore = createStore(browserStorage, 'clipkey.history.v1', [], validHistory)
// Off by default: copied passwords must not end up stored on the phone unless asked for.
const historyFlag = createStore(browserStorage, 'clipkey.history.enabled.v1', false, (v) => v === true)

const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

const preview = (text) => text.replace(/\s+/g, ' ').trim()

/**
 * @param {{ sendText: (text: string) => Promise<boolean>, fillInput: (text: string) => void,
 *           notify: (msg: string) => void }} deps  sendText resolves true when fully typed
 */
export function setupPhrases({ sendText, fillInput, notify }) {
  const $ = (id) => document.getElementById(id)
  let snippets = snippetStore.load()
  let history = historyStore.load()
  let historyOn = historyFlag.load()
  let sending = false // ignore extra taps while a phrase is being typed

  async function sendOnce(text) {
    if (sending) return
    sending = true
    try {
      await sendText(text)
    } finally {
      sending = false
    }
  }

  const persist = (store, value) => {
    if (!store.save(value)) notify('이 브라우저에서는 저장할 수 없습니다 (저장소 차단)')
  }

  // ---- saved phrases ----------------------------------------------------

  function renderSnippets() {
    $('snippetEmpty').classList.toggle('hidden', snippets.length > 0)
    $('snippetList').replaceChildren(
      ...snippets.map((s) =>
        el('div', { className: 'phrase-row' }, [
          el('button', { className: 'phrase-main one-line', onclick: () => sendOnce(s.text) }, [
            el('strong', { textContent: s.title }),
            el('span', { className: 'preview', textContent: preview(s.text) }),
          ]),
          el('button', { className: 'btn small', textContent: '편집', onclick: () => editSnippet(s) }),
        ]),
      ),
    )
  }

  function editSnippet(existing) {
    const dialog = $('snippetDialog')
    $('snippetDialogTitle').textContent = existing ? '문구 편집' : '문구 추가'
    $('snippetTitle').value = existing?.title ?? ''
    $('snippetText').value = existing?.text ?? ''
    $('snippetDeleteBtn').classList.toggle('hidden', !existing)
    $('snippetUpBtn').classList.toggle('hidden', !existing)
    dialog.returnValue = ''
    dialog.onclose = () => {
      const action = dialog.returnValue
      try {
        if (action === 'save') {
          snippets = upsertSnippet(snippets, { id: existing?.id, title: $('snippetTitle').value, text: $('snippetText').value })
        } else if (action === 'delete' && existing) {
          askConfirm(`"${existing.title}" 문구를 삭제할까요?`, { okText: '삭제' }).then((ok) => {
            if (!ok) return
            snippets = removeSnippet(snippets, existing.id)
            persist(snippetStore, snippets)
            renderSnippets()
          })
          return
        } else if (action === 'up' && existing) {
          snippets = moveSnippet(snippets, existing.id, -1)
        } else {
          return
        }
      } catch (error) {
        notify(error.message)
        return
      }
      persist(snippetStore, snippets)
      renderSnippets()
    }
    dialog.showModal()
  }

  // ---- recent texts -----------------------------------------------------

  function renderHistory() {
    $('historyEnabled').checked = historyOn
    $('historyCount').textContent = history.length ? `(${history.length})` : ''
    $('historyClearBtn').classList.toggle('hidden', !history.some((h) => !h.pinned))
    $('historyList').replaceChildren(
      ...history.map((h) =>
        el('div', { className: 'phrase-row' }, [
          el('input', {
            type: 'checkbox',
            className: 'pin',
            checked: h.pinned,
            title: '고정 (맨 위에 두고 20개 제한에서 지우지 않음)',
            ariaLabel: '고정',
            onchange: () => {
              history = togglePin(history, h.text)
              persist(historyStore, history)
              renderHistory()
            },
          }),
          el('button', { className: 'phrase-main', title: '입력칸에 넣기', onclick: () => fillInput(h.text) }, [
            el('span', { className: 'preview', textContent: preview(h.text) }),
          ]),
          el('button', { className: 'btn small primary', textContent: '보내기', onclick: () => sendOnce(h.text) }),
          el('button', {
            className: 'btn small',
            textContent: '×',
            title: '기록에서 지우기',
            onclick: () => {
              history = removeFromHistory(history, h.text)
              persist(historyStore, history)
              renderHistory()
            },
          }),
        ]),
      ),
    )
  }

  $('snippetAddBtn').addEventListener('click', () => editSnippet(null))
  $('historyEnabled').addEventListener('change', (e) => {
    historyOn = e.target.checked
    persist(historyFlag, historyOn)
    notify(historyOn ? `보낸 텍스트를 최근 ${HISTORY_LIMIT}개까지 기록합니다` : '이제부터 기록하지 않습니다')
    if (!historyOn && history.some((h) => !h.pinned)) {
      askConfirm('지금까지의 기록도 지울까요? (고정한 항목은 남습니다)', { okText: '지우기', cancelText: '남겨 두기' }).then((ok) => {
        if (!ok) return
        history = clearUnpinned(history)
        persist(historyStore, history)
        renderHistory()
      })
    }
  })
  $('historyClearBtn').addEventListener('click', async () => {
    if (!(await askConfirm('기록을 지울까요? (고정한 항목은 남습니다)', { okText: '지우기' }))) return
    history = clearUnpinned(history)
    persist(historyStore, history)
    renderHistory()
  })

  renderSnippets()
  renderHistory()

  return Object.freeze({
    /** Call after a text was fully typed on the PC (not for clipboard sends). */
    record(text) {
      if (!historyOn) return
      history = addToHistory(history, text)
      persist(historyStore, history)
      renderHistory()
    },
  })
}

// Settings: list of paired PCs / tablets, with type (Windows / Apple) and delete.

import { SECURE_MSG, HOST_PROFILE_LABEL } from './constants.js'
import { errorText } from './log.js'
import { askConfirm, askText } from './modal.js'
import {
  encodeListHosts,
  encodeDeleteHost,
  encodeSetHostProfile,
  encodeSetHostAlias,
  formatHostAddr,
  hostTitle,
} from './hosts.js'

const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

/**
 * @param {{ client, notify: (msg: string) => void, onChange?: (hosts) => void,
 *           onSelect?: (host) => void }} deps
 */
export function setupHostsUi({ client, notify, onChange = () => {}, onSelect = () => {} }) {
  const list = document.getElementById('hostList')
  const refreshBtn = document.getElementById('hostRefreshBtn')
  let incoming = [] // HOST entries by index until HOSTS_END
  let hosts = []
  let retries = 0
  const MAX_RETRIES = 2

  const send = (frame) => client.send(frame).catch((e) => notify(`전송 실패: ${errorText(e)}`))

  function refresh() {
    if (!client.connected) return
    incoming = []
    send(encodeListHosts())
  }

  function profileSelect(host) {
    const select = el('select', { className: 'inline-select' })
    Object.entries(HOST_PROFILE_LABEL).forEach(([value, label]) => select.add(new Option(label, value)))
    select.value = String(host.profile)
    select.addEventListener('change', () => {
      send(encodeSetHostProfile(host.addr, Number(select.value))).then(refresh)
    })
    return select
  }

  function renameButton(host) {
    return el('button', {
      className: 'btn small',
      textContent: '별명',
      onclick: async () => {
        const value = await askText('이 PC·태블릿의 별명 (예: 회사 노트북, 비우면 지움)', host.alias, { okText: '저장' })
        if (value === null) return
        let frame
        try {
          frame = encodeSetHostAlias(host.addr, value)
        } catch (error) {
          notify(error.message)
          return
        }
        send(frame).then(refresh)
      },
    })
  }

  function deleteButton(host, title) {
    return el('button', {
      className: 'btn danger small',
      textContent: '삭제',
      onclick: async () => {
        const warn = host.connected ? '\n지금 연결되어 있다면 바로 끊깁니다.' : ''
        const ok = await askConfirm(
          `"${title}" 페어링을 삭제할까요?${warn}\n다시 쓰려면 PC의 블루투스 설정에서도 ClipKey를 "디바이스 제거"한 뒤, "PC 블루투스 연결 추가"로 새로 페어링하세요.`,
          { okText: '삭제' },
        )
        if (!ok) return
        send(encodeDeleteHost(host.addr)).then(() => {
          notify(`${title} 삭제됨. PC의 블루투스 설정에서도 ClipKey를 제거해야 다시 페어링할 수 있습니다`)
          refresh()
        })
      },
    })
  }

  function render() {
    if (!client.connected) {
      list.replaceChildren(el('p', { className: 'hint', textContent: '기기에 연결하면 목록이 표시됩니다.' }))
      return
    }
    if (hosts.length === 0) {
      list.replaceChildren(el('p', { className: 'hint', textContent: '페어링된 PC·태블릿이 없습니다.' }))
      return
    }
    list.replaceChildren(
      ...hosts.map((host) => {
        const title = hostTitle(host)
        const state = host.active ? '입력 중' : host.connected ? '연결됨' : '연결 안 됨'
        const own = host.alias && host.name ? host.name : ''
        const sub = [state, own, formatHostAddr(host.addr), host.detected ? '' : '종류 감지 전']
          .filter(Boolean)
          .join(' · ')
        return el('div', { className: `host-row${host.active ? ' active' : ''}` }, [
          el('div', { className: 'host-main' }, [
            el('strong', { textContent: title }),
            el('span', { className: 'hint', textContent: sub }),
          ]),
          el('div', { className: 'row' }, [
            profileSelect(host),
            ...(host.connected && !host.active
              ? [el('button', { className: 'btn small primary', textContent: '여기로 입력', onclick: () => onSelect(host) })]
              : []),
            renameButton(host),
            deleteButton(host, title),
          ]),
        ])
      }),
    )
  }

  refreshBtn.addEventListener('click', refresh)

  return Object.freeze({
    refresh,
    onSecure(msg) {
      if (msg.type === SECURE_MSG.HOST) {
        const next = [...incoming]
        next[msg.index] = msg.host
        incoming = next
      }
      if (msg.type === SECURE_MSG.HOSTS_END) {
        const complete = incoming.filter(Boolean)
        incoming = []
        if (complete.length !== msg.total && retries < MAX_RETRIES) {
          retries += 1
          refresh() // an entry was lost on the air: ask again
          return
        }
        retries = 0
        hosts = complete
        render()
        onChange(hosts)
      }
    },
    render,
    get hosts() {
      return hosts
    },
    /** The paired host currently receiving keystrokes, if known. */
    get activeHost() {
      return hosts.find((h) => h.active) ?? null
    },
    clear() {
      hosts = []
      onChange(hosts)
    },
  })
}

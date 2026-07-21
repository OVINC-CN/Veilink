import {
  CheckCircle,
  ClockCountdown,
  Fingerprint,
  LockKey,
  PlugsConnected,
  ShieldCheck,
  Trash,
  WarningOctagon,
  X,
} from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { ActiveRoom } from '../models'
import type { Preferences } from '../preferences'
import { MemberAvatar } from './MemberAvatar'

const drawerMediaQuery = '(max-width: 1180px)'

function matchesMedia(query: string): boolean {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(query).matches
}

function formatRemaining(expiresAt: number): string {
  const seconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return [hours, minutes, rest].map((value) => String(value).padStart(2, '0')).join(':')
}

export function RoomSidePanel({
  room,
  preferences,
  connectionState,
  open,
  onClose,
  onDestroy,
}: {
  room: ActiveRoom
  preferences: Preferences
  connectionState: 'connecting' | 'ready'
  open: boolean
  onClose: () => void
  onDestroy: () => Promise<void> | void
}) {
  const [remaining, setRemaining] = useState(() => formatRemaining(room.expiresAt))
  const [destroyOpen, setDestroyOpen] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [drawerMode, setDrawerMode] = useState(() => matchesMedia(drawerMediaQuery))
  const dialog = useRef<HTMLElement>(null)
  const zh = preferences.locale === 'zh-CN'
  const isOwner = room.ownerId === room.memberId
  const fingerprintSuffix = room.fingerprint.replaceAll(' ', '').slice(-4).toUpperCase()
  const destroyValid = confirmation.trim().toUpperCase() === fingerprintSuffix

  useEffect(() => {
    const timer = window.setInterval(() => setRemaining(formatRemaining(room.expiresAt)), 1_000)
    return () => window.clearInterval(timer)
  }, [room.expiresAt])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(drawerMediaQuery)
    const update = (): void => setDrawerMode(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!destroyOpen) return
    const keepFocusInside = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setDestroyOpen(false)
        setConfirmation('')
        return
      }
      if (event.key !== 'Tab' || !dialog.current) return
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', keepFocusInside)
    return () => document.removeEventListener('keydown', keepFocusInside)
  }, [destroyOpen])

  const closeDestroy = (): void => {
    setDestroyOpen(false)
    setConfirmation('')
  }

  return (
    <>
      {open ? <button className="details-scrim" type="button" aria-label={zh ? '关闭连接详情' : 'Close connection details'} onClick={onClose} /> : null}
      <aside
        className={`room-side-panel${open ? ' is-open' : ''}`}
        aria-label={zh ? '连接详情' : 'Connection details'}
        aria-hidden={drawerMode && !open}
        inert={drawerMode && !open ? true : undefined}
      >
        <header className="side-panel-header">
          <div>
            <span>{zh ? '连接详情' : 'Connection details'}</span>
            <strong>{room.members.length} {zh ? '人在线' : 'online'}</strong>
          </div>
          <button className="icon-button side-panel-close" type="button" aria-label={zh ? '关闭' : 'Close'} onClick={onClose}><X /></button>
        </header>

        <section className="side-section members-section">
          <div className="side-section-title"><span>{zh ? '成员' : 'Members'}</span><small>{room.members.length}/8</small></div>
          <ul className="side-member-list">
            {[...room.members]
              .sort((left, right) => Number(right.isOwner) - Number(left.isOwner) || left.joinedAt - right.joinedAt)
              .map((member) => (
                <li key={member.id}>
                  <span className="avatar-presence"><MemberAvatar seed={member.identityPublicKey} /><i /></span>
                  <span className="member-copy">
                    <strong>{member.nickname}{member.id === room.memberId ? (zh ? '（你）' : ' (you)') : ''}</strong>
                    <small>{member.isOwner ? (zh ? '房间发起人' : 'Room host') : (zh ? '已安全连接' : 'Securely connected')}</small>
                  </span>
                  {member.id === room.memberId ? <span className="self-chip">{zh ? '本设备' : 'This device'}</span> : null}
                </li>
              ))}
          </ul>
        </section>

        <section className="side-section connection-section">
          <div className="side-section-title"><span>{zh ? '连接状态' : 'Connection status'}</span><PlugsConnected /></div>
          <ul className="connection-facts">
            <li><CheckCircle weight="fill" /><span><strong>{zh ? 'P2P 直连' : 'P2P direct'}</strong><small>{connectionState === 'ready' ? (zh ? '已连接' : 'Connected') : (zh ? '建立中' : 'Connecting')}</small></span></li>
            <li><ShieldCheck weight="fill" /><span><strong>{zh ? '端到端加密' : 'End-to-end encrypted'}</strong><small>{zh ? '已启用' : 'Enabled'}</small></span></li>
            <li><LockKey weight="fill" /><span><strong>{zh ? '无中继' : 'No relay'}</strong><small>{zh ? '已强制' : 'Enforced'}</small></span></li>
          </ul>
          <p className="connection-explainer">{zh ? '聊天和文件只通过成员设备间的直接 DataChannel 传输；无法直连时会安全失败。' : 'Chats and files use direct member-to-member DataChannels only; the connection fails closed when a direct path is unavailable.'}</p>
        </section>

        <section className="side-section room-information">
          <div className="side-section-title"><span>{zh ? '房间信息' : 'Room information'}</span></div>
          <dl>
            <div><dt><ClockCountdown />{zh ? '临时房间' : 'Ephemeral room'}</dt><dd>{remaining}</dd></div>
            <div><dt><Fingerprint />{zh ? '密钥指纹' : 'Key fingerprint'}</dt><dd>{fingerprintSuffix}</dd></div>
          </dl>
        </section>

        {isOwner ? (
          <button className="side-destroy-button" type="button" onClick={() => setDestroyOpen(true)}><Trash /><span>{zh ? '销毁房间' : 'Destroy room'}</span></button>
        ) : null}
        <p className="side-panel-footnote">{zh ? '离开或销毁后，本标签页中的恢复数据会被清除。' : 'Leaving or destroying clears recovery data from this tab.'}</p>
      </aside>

      {destroyOpen ? (
        <div className="modal-scrim" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) closeDestroy() }}>
          <section ref={dialog} className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="side-destroy-title">
            <button className="dialog-close icon-button" type="button" aria-label={zh ? '关闭' : 'Close'} onClick={closeDestroy}><X /></button>
            <span className="dialog-symbol"><WarningOctagon weight="duotone" /></span>
            <h2 id="side-destroy-title">{zh ? '确认销毁？' : 'Confirm destruction?'}</h2>
            <p>{zh ? '所有成员将立即断开，且无法恢复。请输入密钥指纹末 4 位以确认。' : 'Everyone will be disconnected immediately and access cannot be restored. Enter the final 4 characters of the key fingerprint to confirm.'}</p>
            <label className="confirmation-field">
              <span>{zh ? `输入 ${fingerprintSuffix}` : `Enter ${fingerprintSuffix}`}</span>
              <input autoFocus autoComplete="off" spellCheck="false" maxLength={4} value={confirmation} onChange={(event) => setConfirmation(event.target.value.toUpperCase())} onKeyDown={(event) => {
                if (event.key !== 'Enter' || !destroyValid) return
                closeDestroy()
                void onDestroy()
              }} />
            </label>
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={closeDestroy}>{zh ? '取消' : 'Cancel'}</button>
              <button className="destructive-button" type="button" disabled={!destroyValid} onClick={() => { closeDestroy(); void onDestroy() }}>{zh ? '销毁房间' : 'Destroy room'}</button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}

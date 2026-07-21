import {
  CheckCircle,
  ClockCountdown,
  Fingerprint,
  LockKey,
  PlugsConnected,
  ShieldCheck,
  WarningOctagon,
  X,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActiveRoom } from '../models'
import type { Preferences } from '../preferences'
import { MemberAvatar } from './MemberAvatar'

function formatRemaining(expiresAt: number): string {
  const seconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return [hours, minutes, rest].map((value) => String(value).padStart(2, '0')).join(':')
}

export function RoomConnectionDetails({
  room,
  preferences,
  connectionState,
}: {
  room: ActiveRoom
  preferences: Preferences
  connectionState: 'connecting' | 'ready'
}) {
  const [remaining, setRemaining] = useState(() => formatRemaining(room.expiresAt))
  const zh = preferences.locale === 'zh-CN'
  const fingerprintSuffix = room.fingerprint.replaceAll(' ', '').slice(-4).toUpperCase()

  useEffect(() => {
    const timer = window.setInterval(() => setRemaining(formatRemaining(room.expiresAt)), 1_000)
    return () => window.clearInterval(timer)
  }, [room.expiresAt])

  return (
    <div className="room-details-content">
      <header className="room-details-header">
        <span>
          <strong>{zh ? '在线成员' : 'Online members'}</strong>
          <small>{room.members.length}/8</small>
        </span>
      </header>

      <ul className="room-member-list">
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

      <section className="room-details-section" aria-labelledby="connection-details-heading">
        <div className="room-details-title">
          <strong id="connection-details-heading">{zh ? '连接状态' : 'Connection status'}</strong>
          <PlugsConnected />
        </div>
        <ul className="connection-facts">
          <li><CheckCircle weight="fill" /><span><strong>{zh ? 'Cloudflare TURN 中继' : 'Cloudflare TURN relay'}</strong><small>{connectionState === 'ready' ? (zh ? '已连接' : 'Connected') : (zh ? '建立中' : 'Connecting')}</small></span></li>
          <li><ShieldCheck weight="fill" /><span><strong>{zh ? '端到端加密' : 'End-to-end encrypted'}</strong><small>{zh ? '已启用' : 'Enabled'}</small></span></li>
          <li><LockKey weight="fill" /><span><strong>{zh ? '仅允许中继' : 'Relay only'}</strong><small>{zh ? '已强制' : 'Enforced'}</small></span></li>
        </ul>
        <p className="connection-explainer">{zh ? '聊天和文件经 Cloudflare TURN 中继传输；应用层内容保持端到端加密，不会降级为直连。' : 'Chats and files use Cloudflare TURN relays; application content remains end-to-end encrypted and never falls back to a direct path.'}</p>
      </section>

      <section className="room-details-section room-information" aria-labelledby="room-information-heading">
        <div className="room-details-title"><strong id="room-information-heading">{zh ? '房间信息' : 'Room information'}</strong></div>
        <dl>
          <div><dt><ClockCountdown />{zh ? '剩余时间' : 'Time remaining'}</dt><dd>{remaining}</dd></div>
          <div><dt><Fingerprint />{zh ? '密钥指纹' : 'Key fingerprint'}</dt><dd>{fingerprintSuffix}</dd></div>
        </dl>
      </section>
    </div>
  )
}

export function DestroyRoomDialog({
  room,
  preferences,
  open,
  onClose,
  onDestroy,
}: {
  room: ActiveRoom
  preferences: Preferences
  open: boolean
  onClose: () => void
  onDestroy: () => Promise<void> | void
}) {
  const [confirmation, setConfirmation] = useState('')
  const dialog = useRef<HTMLElement>(null)
  const zh = preferences.locale === 'zh-CN'
  const fingerprintSuffix = room.fingerprint.replaceAll(' ', '').slice(-4).toUpperCase()
  const destroyValid = confirmation.trim().toUpperCase() === fingerprintSuffix
  const close = useCallback((): void => {
    setConfirmation('')
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const keepFocusInside = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
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
  }, [close, open])

  if (!open) return null

  const destroy = (): void => {
    if (!destroyValid) return
    close()
    void onDestroy()
  }

  return (
    <div className="modal-scrim" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <section ref={dialog} className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="destroy-room-title">
        <button className="dialog-close icon-button" type="button" aria-label={zh ? '关闭' : 'Close'} onClick={close}><X /></button>
        <span className="dialog-symbol"><WarningOctagon weight="duotone" /></span>
        <h2 id="destroy-room-title">{zh ? '销毁这个房间？' : 'Destroy this room?'}</h2>
        <p>{zh ? '所有成员将立即断开，且无法恢复。请输入密钥指纹末 4 位以确认。' : 'Everyone will be disconnected immediately and access cannot be restored. Enter the final 4 characters of the key fingerprint to confirm.'}</p>
        <label className="confirmation-field">
          <span>{zh ? `输入 ${fingerprintSuffix}` : `Enter ${fingerprintSuffix}`}</span>
          <input autoFocus autoComplete="off" spellCheck="false" maxLength={4} value={confirmation} onChange={(event) => setConfirmation(event.target.value.toUpperCase())} onKeyDown={(event) => { if (event.key === 'Enter') destroy() }} />
        </label>
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={close}>{zh ? '取消' : 'Cancel'}</button>
          <button className="destructive-button" type="button" disabled={!destroyValid} onClick={destroy}>{zh ? '销毁房间' : 'Destroy room'}</button>
        </div>
      </section>
    </div>
  )
}

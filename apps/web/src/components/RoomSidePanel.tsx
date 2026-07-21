import {
  SignOut,
  WarningOctagon,
  X,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActiveRoom } from '../models'
import type { Preferences } from '../preferences'
import { MemberAvatar } from './MemberAvatar'

export function RoomMemberList({
  room,
  preferences,
}: {
  room: ActiveRoom
  preferences: Preferences
}) {
  const zh = preferences.locale === 'zh-CN'

  return (
    <div className="room-details-content">
      <header className="popover-title room-details-header">
        <strong>{zh ? '人员列表' : 'Members'}</strong>
        <small>{zh ? `${room.members.length}/8 人在线` : `${room.members.length}/8 online`}</small>
      </header>

      <ul className="room-member-list">
        {[...room.members]
          .sort((left, right) => Number(right.isOwner) - Number(left.isOwner) || left.joinedAt - right.joinedAt)
          .map((member) => (
            <li key={member.id}>
              <span className="avatar-presence"><MemberAvatar seed={member.identityPublicKey} /><i /></span>
              <span className="member-copy">
                <strong>{member.nickname}{member.id === room.memberId ? (zh ? '（你）' : ' (you)') : ''}</strong>
                <small>{member.isOwner ? (zh ? '房间发起人' : 'Room host') : (zh ? '房间成员' : 'Room member')}</small>
              </span>
              {member.id === room.memberId ? <span className="self-chip">{zh ? '本设备' : 'This device'}</span> : null}
            </li>
          ))}
      </ul>
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

export function LeaveRoomDialog({
  room,
  preferences,
  open,
  onClose,
  onLeave,
}: {
  room: ActiveRoom
  preferences: Preferences
  open: boolean
  onClose: () => void
  onLeave: () => void
}) {
  const dialog = useRef<HTMLElement>(null)
  const zh = preferences.locale === 'zh-CN'
  const isOwner = room.ownerId === room.memberId
  const hasOtherMembers = room.members.some((member) => member.id !== room.memberId)
  const close = useCallback((): void => onClose(), [onClose])

  useEffect(() => {
    if (!open) return
    const keepFocusInside = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== 'Tab' || !dialog.current) return
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex]:not([tabindex="-1"])')]
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

  const message = isOwner
    ? hasOtherMembers
      ? (zh
          ? '退出后，本设备将清除当前会话的安全恢复信息，且房主身份会自动移交给最早加入的其他成员。'
          : 'This device will erase its secure recovery state, and host ownership will pass to the earliest remaining member.')
      : (zh
          ? '退出后，本设备将清除当前会话的安全恢复信息。房间会保留至到期，下一位加入的成员将成为房主。'
          : 'This device will erase its secure recovery state. The room will remain until expiry, and the next member to join will become the host.')
    : (zh
        ? '退出后，本设备将清除当前会话的安全恢复信息，无法恢复为当前成员。'
        : 'This device will erase its secure recovery state and cannot resume as the current member.')

  const leave = (): void => {
    close()
    onLeave()
  }

  return (
    <div className="modal-scrim" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <section ref={dialog} className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="leave-room-title">
        <button className="dialog-close icon-button" type="button" aria-label={zh ? '关闭' : 'Close'} onClick={close}><X /></button>
        <span className="dialog-symbol"><SignOut weight="duotone" /></span>
        <h2 id="leave-room-title">{zh ? '退出这个房间？' : 'Leave this room?'}</h2>
        <p>{message}</p>
        <div className="dialog-actions">
          <button autoFocus className="secondary-button" type="button" onClick={close}>{zh ? '取消' : 'Cancel'}</button>
          <button className="destructive-button" type="button" onClick={leave}>{zh ? '确认退出' : 'Leave room'}</button>
        </div>
      </section>
    </div>
  )
}

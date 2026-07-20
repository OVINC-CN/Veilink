import { useEffect, useRef, useState } from 'react'
import {
  CaretDown,
  Check,
  Copy,
  DotsThree,
  GearSix,
  ShieldCheck,
  SignOut,
  Trash,
  Users,
  WarningOctagon,
  X,
} from '@phosphor-icons/react'
import { t } from '../i18n'
import type { ActiveRoom } from '../models'
import type { Preferences } from '../preferences'
import { Brand } from './Brand'
import { MemberAvatar } from './MemberAvatar'

type Panel = 'members' | 'security' | 'settings' | 'more' | null

interface RoomTopBarProps {
  room: ActiveRoom
  preferences: Preferences
  onPreferences: (next: Preferences) => void
  onLeave: () => void
  onDestroy: () => Promise<void> | void
}

function formatRemaining(expiresAt: number): string {
  const seconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return [hours, minutes, rest].map((value) => String(value).padStart(2, '0')).join(':')
}

export function RoomTopBar({ room, preferences, onPreferences, onLeave, onDestroy }: RoomTopBarProps) {
  const [panel, setPanel] = useState<Panel>(null)
  const [remaining, setRemaining] = useState(() => formatRemaining(room.expiresAt))
  const [copied, setCopied] = useState(false)
  const [destroyOpen, setDestroyOpen] = useState(false)
  const [destroyConfirmation, setDestroyConfirmation] = useState('')
  const root = useRef<HTMLElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const destroyDialog = useRef<HTMLElement>(null)
  const self = room.members.find((member) => member.id === room.memberId)
  const isOwner = room.ownerId === room.memberId
  const zh = preferences.locale === 'zh-CN'
  const fingerprintSuffix = room.fingerprint.replaceAll(' ', '').slice(-4).toUpperCase()
  const destroyValid = destroyConfirmation.trim().toUpperCase() === fingerprintSuffix

  useEffect(() => {
    const timer = window.setInterval(() => setRemaining(formatRemaining(room.expiresAt)), 1000)
    return () => window.clearInterval(timer)
  }, [room.expiresAt])

  useEffect(() => {
    const close = (event: MouseEvent): void => {
      if (root.current && !root.current.contains(event.target as Node)) setPanel(null)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setPanel(null)
      setDestroyOpen(false)
      setDestroyConfirmation('')
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [])

  useEffect(() => {
    if (!destroyOpen) return
    const dialog = destroyDialog.current
    if (!dialog) return

    const keepFocusInside = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setDestroyOpen(false)
        setDestroyConfirmation('')
        window.requestAnimationFrame(() => moreButton.current?.focus())
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
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

  const toggle = (next: Exclude<Panel, null>): void => setPanel((current) => current === next ? null : next)
  const copyInvitation = async (): Promise<void> => {
    const invitation = `${window.location.origin}/room/${room.roomId}#${room.linkSecret}`
    await navigator.clipboard.writeText(invitation)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const openDestroy = (): void => {
    setPanel(null)
    setDestroyConfirmation('')
    setDestroyOpen(true)
  }

  const closeDestroy = (): void => {
    setDestroyOpen(false)
    setDestroyConfirmation('')
    window.requestAnimationFrame(() => moreButton.current?.focus())
  }

  const confirmDestroy = (): void => {
    if (!destroyValid) return
    setDestroyOpen(false)
    setDestroyConfirmation('')
    void onDestroy()
  }

  return (
    <>
    <header className="topbar" ref={root}>
      <div className="topbar-inner">
        <Brand />
        <div className="room-summary" aria-label={zh ? '房间状态' : 'Room status'}>
          <span className="secure-dot" />
          <strong>{t(preferences.locale, 'turn')}</strong>
          <span className="summary-divider" aria-hidden="true" />
          <time aria-label={`${t(preferences.locale, 'expires')} ${remaining}`}>{remaining}</time>
        </div>
        <nav className="top-actions" aria-label={zh ? '房间控制' : 'Room controls'}>
        <div className="popover-anchor">
          <button className="top-action" type="button" aria-expanded={panel === 'members'} onClick={() => toggle('members')}>
            <Users /><span>{t(preferences.locale, 'members')} {room.members.length}</span><CaretDown />
          </button>
          {panel === 'members' ? (
            <section className="popover members-popover" aria-label={t(preferences.locale, 'members')}>
              <div className="popover-title"><strong>{t(preferences.locale, 'members')}</strong><span>{room.members.length}/8</span></div>
              <ul className="member-list">
                {[...room.members].sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || a.joinedAt - b.joinedAt).map((member) => (
                  <li key={member.id}>
                    <MemberAvatar seed={member.identityPublicKey} />
                    <span className="member-copy">
                      <strong>{member.nickname}{member.id === room.memberId ? (zh ? '（你）' : ' (you)') : ''}</strong>
                      {member.isOwner ? <small>{t(preferences.locale, 'owner')}</small> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <div className="popover-anchor">
          <button className="icon-button top-icon" type="button" aria-label={t(preferences.locale, 'security')} aria-expanded={panel === 'security'} onClick={() => toggle('security')}><ShieldCheck /></button>
          {panel === 'security' ? (
            <section className="popover security-popover">
              <div className="popover-title"><strong>{t(preferences.locale, 'security')}</strong><span className="status-chip">E2EE</span></div>
              <p>{zh ? '共享密钥指纹' : 'Shared key fingerprint'}</p>
              <code className="fingerprint">{room.fingerprint}</code>
              <p className="popover-note">{zh ? '请通过其他渠道核对指纹。Veilink 不宣称双棘轮或完全前向保密。' : 'Verify this fingerprint through another channel. Veilink does not claim double-ratchet encryption or full forward secrecy.'}</p>
              <dl className="security-facts"><div><dt>{t(preferences.locale, 'expires')}</dt><dd>{remaining}</dd></div><div><dt>{zh ? '会话' : 'Session'}</dt><dd>{zh ? '仅内存' : 'Memory only'}</dd></div></dl>
            </section>
          ) : null}
        </div>

        <div className="popover-anchor">
          <button className="icon-button top-icon" type="button" aria-label={t(preferences.locale, 'settings')} aria-expanded={panel === 'settings'} onClick={() => toggle('settings')}><GearSix /></button>
          {panel === 'settings' ? (
            <section className="popover settings-popover">
              <div className="popover-title"><strong>{t(preferences.locale, 'settings')}</strong></div>
              <label>{zh ? '主题' : 'Theme'}<select value={preferences.theme} onChange={(event) => onPreferences({ ...preferences, theme: event.target.value as Preferences['theme'] })}><option value="system">{zh ? '跟随系统' : 'System'}</option><option value="light">{zh ? '浅色' : 'Light'}</option><option value="dark">{zh ? '深色' : 'Dark'}</option></select></label>
              <label>{zh ? '语言' : 'Language'}<select value={preferences.locale} onChange={(event) => onPreferences({ ...preferences, locale: event.target.value as Preferences['locale'] })}><option value="zh-CN">简体中文</option><option value="en-US">English</option></select></label>
              <label>{zh ? '文件上限' : 'File limit'}<input type="number" min="1" max="256" value={preferences.maxFileSizeMb} onChange={(event) => onPreferences({ ...preferences, maxFileSizeMb: Number(event.target.value) })} /><span>MiB</span></label>
              <label>{zh ? '发送快捷键' : 'Send shortcut'}<select value={preferences.sendShortcut} onChange={(event) => onPreferences({ ...preferences, sendShortcut: event.target.value as Preferences['sendShortcut'] })}><option value="enter">Enter</option><option value="mod-enter">⌘/Ctrl + Enter</option></select></label>
              <label>{zh ? '消息密度' : 'Message density'}<select value={preferences.density} onChange={(event) => onPreferences({ ...preferences, density: event.target.value as Preferences['density'] })}><option value="comfortable">{zh ? '舒适' : 'Comfortable'}</option><option value="compact">{zh ? '紧凑' : 'Compact'}</option></select></label>
              <label className="checkbox-row"><span>{zh ? '显示时间' : 'Show timestamps'}</span><input type="checkbox" checked={preferences.showTimestamps} onChange={(event) => onPreferences({ ...preferences, showTimestamps: event.target.checked })} /></label>
              <label className="checkbox-row"><span>{zh ? '记住昵称' : 'Remember nickname'}</span><input type="checkbox" checked={preferences.rememberNickname} onChange={(event) => onPreferences({ ...preferences, rememberNickname: event.target.checked, ...(event.target.checked && self ? { nickname: self.nickname } : { nickname: undefined }) })} /></label>
            </section>
          ) : null}
        </div>

        <div className="popover-anchor">
          <button ref={moreButton} className="icon-button top-icon" type="button" aria-label={t(preferences.locale, 'more')} aria-expanded={panel === 'more'} onClick={() => toggle('more')}><DotsThree /></button>
          {panel === 'more' ? (
            <section className="popover more-popover">
              <button className="menu-row" type="button" onClick={() => void copyInvitation()}>{copied ? <Check /> : <Copy />}<span aria-live="polite">{copied ? t(preferences.locale, 'copied') : t(preferences.locale, 'copyLink')}</span></button>
              <p className="popover-note">{zh ? '邀请链接可能被系统剪贴板历史或云同步保留。' : 'Clipboard history or cloud sync may retain invitation links.'}</p>
              <button className="menu-row" type="button" onClick={onLeave}><SignOut /><span>{t(preferences.locale, 'leave')}</span></button>
              {isOwner ? <button className="menu-row destructive" type="button" onClick={openDestroy}><Trash /><span>{t(preferences.locale, 'destroy')}</span></button> : null}
            </section>
          ) : null}
        </div>
        </nav>
      </div>
    </header>
    {destroyOpen ? (
      <div className="modal-scrim" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) closeDestroy() }}>
        <section ref={destroyDialog} className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="destroy-dialog-title">
          <button className="dialog-close" type="button" aria-label={zh ? '关闭' : 'Close'} onClick={closeDestroy}><X /></button>
          <span className="dialog-symbol"><WarningOctagon weight="duotone" /></span>
          <h2 id="destroy-dialog-title">{zh ? '销毁这个聊天室？' : 'Destroy this room?'}</h2>
          <p>{zh ? '所有成员将立即断开，房间无法恢复。请输入密钥指纹末 4 位以确认。' : 'Everyone will be disconnected immediately and the room cannot be recovered. Enter the final 4 characters of the key fingerprint to confirm.'}</p>
          <label className="confirmation-field">
            <span>{zh ? `输入 ${fingerprintSuffix}` : `Enter ${fingerprintSuffix}`}</span>
            <input autoFocus autoComplete="off" spellCheck="false" maxLength={4} value={destroyConfirmation} onChange={(event) => setDestroyConfirmation(event.target.value.toUpperCase())} onKeyDown={(event) => { if (event.key === 'Enter') confirmDestroy() }} />
          </label>
          <div className="dialog-actions">
            <button className="secondary-button" type="button" onClick={closeDestroy}>{zh ? '取消' : 'Cancel'}</button>
            <button className="destructive-button" type="button" disabled={!destroyValid} onClick={confirmDestroy}>{t(preferences.locale, 'destroy')}</button>
          </div>
        </section>
      </div>
    ) : null}
    </>
  )
}

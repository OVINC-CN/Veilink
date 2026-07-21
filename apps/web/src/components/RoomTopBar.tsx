import {
  ArrowsClockwise,
  Bell,
  CaretDown,
  Check,
  Copy,
  DotsThree,
  GearSix,
  LockKey,
  PlugsConnected,
  ShieldCheck,
  SignOut,
  Users,
} from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import type { ActiveRoom } from '../models'
import type { Preferences } from '../preferences'
import { mentionNotificationAvailability, requestMentionNotificationPermission } from '../mentionNotifications'
import { Brand } from './Brand'

type Panel = 'settings' | 'more' | null

interface RoomTopBarProps {
  room: ActiveRoom
  preferences: Preferences
  connectionState: 'connecting' | 'ready'
  detailsOpen: boolean
  onDetailsToggle: () => void
  onPreferences: (next: Preferences) => void
  onLeave: () => void
}

export function RoomTopBar({
  room,
  preferences,
  connectionState,
  detailsOpen,
  onDetailsToggle,
  onPreferences,
  onLeave,
}: RoomTopBarProps) {
  const [panel, setPanel] = useState<Panel>(null)
  const [copied, setCopied] = useState(false)
  const [requestingNotifications, setRequestingNotifications] = useState(false)
  const root = useRef<HTMLElement>(null)
  const self = room.members.find((member) => member.id === room.memberId)
  const zh = preferences.locale === 'zh-CN'
  const notificationAvailability = mentionNotificationAvailability()

  useEffect(() => {
    const close = (event: PointerEvent): void => {
      if (root.current && !root.current.contains(event.target as Node)) setPanel(null)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPanel(null)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [])

  const toggle = (next: Exclude<Panel, null>): void => setPanel((current) => current === next ? null : next)
  const copyInvitation = async (): Promise<void> => {
    await navigator.clipboard.writeText(`${window.location.origin}/room/${room.roomId}#${room.linkSecret}`)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_600)
  }

  const changeMentionNotifications = async (enabled: boolean): Promise<void> => {
    if (!enabled) {
      onPreferences({ ...preferences, mentionNotifications: false, notificationPromptDismissed: true })
      return
    }
    setRequestingNotifications(true)
    const permission = notificationAvailability === 'granted'
      ? 'granted'
      : await requestMentionNotificationPermission()
    onPreferences({
      ...preferences,
      mentionNotifications: permission === 'granted',
      notificationPromptDismissed: true,
    })
    setRequestingNotifications(false)
  }

  return (
    <header className="topbar" ref={root}>
      <div className="topbar-inner">
        <div className="topbar-mobile-brand"><Brand /></div>
        <div className="room-summary" aria-label={zh ? '连接与安全状态' : 'Connection and security status'}>
          <span className={`secure-dot${connectionState === 'ready' ? ' is-ready' : ''}`} />
          <PlugsConnected />
          <strong>{connectionState === 'ready' ? t(preferences.locale, 'direct') : (zh ? '正在建立直连' : 'Establishing direct path')}</strong>
          <span className="summary-divider" aria-hidden="true" />
          <ShieldCheck />
          <span>{zh ? '端到端加密' : 'End-to-end encrypted'}</span>
          <span className="summary-divider" aria-hidden="true" />
          <LockKey />
          <span>{zh ? '无中继' : 'No relay'}</span>
        </div>
        <span className="refresh-safe-status"><ArrowsClockwise /><span>{zh ? '支持安全刷新' : 'Refresh-safe'}</span></span>

        <nav className="top-actions" aria-label={zh ? '房间操作' : 'Room controls'}>
          <button className="top-action members-trigger" type="button" aria-label={zh ? `成员与连接，${room.members.length} 人在线` : `Members and connection, ${room.members.length} online`} aria-expanded={detailsOpen} onClick={onDetailsToggle}>
            <Users /><span>{room.members.length} {zh ? '人在线' : 'online'}</span><CaretDown />
          </button>

          <div className="popover-anchor">
            <button className="icon-button top-icon" type="button" aria-label={t(preferences.locale, 'settings')} aria-expanded={panel === 'settings'} onClick={() => toggle('settings')}><GearSix /></button>
            {panel === 'settings' ? (
              <section className="popover settings-popover" aria-label={t(preferences.locale, 'settings')}>
                <div className="popover-title"><strong>{t(preferences.locale, 'settings')}</strong></div>
                <label>{zh ? '主题' : 'Theme'}<select value={preferences.theme} onChange={(event) => onPreferences({ ...preferences, theme: event.target.value as Preferences['theme'] })}><option value="system">{zh ? '跟随系统' : 'System'}</option><option value="light">{zh ? '浅色' : 'Light'}</option><option value="dark">{zh ? '深色' : 'Dark'}</option></select></label>
                <label>{zh ? '语言' : 'Language'}<select value={preferences.locale} onChange={(event) => onPreferences({ ...preferences, locale: event.target.value as Preferences['locale'] })}><option value="zh-CN">简体中文</option><option value="en-US">English</option></select></label>
                <label>{zh ? '文件上限' : 'File limit'}<input type="number" min="1" max="256" value={preferences.maxFileSizeMb} onChange={(event) => onPreferences({ ...preferences, maxFileSizeMb: Number(event.target.value) })} /><span>MiB</span></label>
                <label>{zh ? '发送快捷键' : 'Send shortcut'}<select value={preferences.sendShortcut} onChange={(event) => onPreferences({ ...preferences, sendShortcut: event.target.value as Preferences['sendShortcut'] })}><option value="enter">Enter</option><option value="mod-enter">⌘/Ctrl + Enter</option></select></label>
                <label>{zh ? '消息密度' : 'Message density'}<select value={preferences.density} onChange={(event) => onPreferences({ ...preferences, density: event.target.value as Preferences['density'] })}><option value="comfortable">{zh ? '舒适' : 'Comfortable'}</option><option value="compact">{zh ? '紧凑' : 'Compact'}</option></select></label>
                <label className="checkbox-row"><span>{zh ? '显示时间' : 'Show timestamps'}</span><input type="checkbox" checked={preferences.showTimestamps} onChange={(event) => onPreferences({ ...preferences, showTimestamps: event.target.checked })} /></label>
                <label className="checkbox-row notification-setting">
                  <span className="setting-copy"><span><Bell />{t(preferences.locale, 'mentionNotifications')}</span>{notificationAvailability === 'denied' ? <small>{t(preferences.locale, 'notificationBlocked')}</small> : null}{notificationAvailability === 'unsupported' ? <small>{t(preferences.locale, 'notificationUnsupported')}</small> : null}</span>
                  <input type="checkbox" checked={preferences.mentionNotifications && notificationAvailability === 'granted'} disabled={requestingNotifications || notificationAvailability === 'denied' || notificationAvailability === 'unsupported'} onChange={(event) => void changeMentionNotifications(event.target.checked)} />
                </label>
                <label className="checkbox-row"><span>{zh ? '记住昵称' : 'Remember nickname'}</span><input type="checkbox" checked={preferences.rememberNickname} onChange={(event) => onPreferences({ ...preferences, rememberNickname: event.target.checked, ...(event.target.checked && self ? { nickname: self.nickname } : { nickname: undefined }) })} /></label>
              </section>
            ) : null}
          </div>

          <div className="popover-anchor">
            <button className="icon-button top-icon" type="button" aria-label={t(preferences.locale, 'more')} aria-expanded={panel === 'more'} onClick={() => toggle('more')}><DotsThree /></button>
            {panel === 'more' ? (
              <section className="popover more-popover">
                <button className="menu-row" type="button" onClick={() => void copyInvitation()}>{copied ? <Check /> : <Copy />}<span aria-live="polite">{copied ? t(preferences.locale, 'copied') : t(preferences.locale, 'copyLink')}</span></button>
                <p className="popover-note">{zh ? '邀请链接可能被系统剪贴板历史或云同步保留。' : 'Clipboard history or cloud sync may retain invitation links.'}</p>
                <button className="menu-row" type="button" onClick={onLeave}><SignOut /><span>{t(preferences.locale, 'leave')}</span></button>
              </section>
            ) : null}
          </div>
        </nav>
      </div>
    </header>
  )
}

import {
  Bell,
  BookmarkSimple,
  CaretDown,
  Check,
  Clock,
  Copy,
  DotsThree,
  FileArrowUp,
  GearSix,
  Key,
  Keyboard,
  Palette,
  Rows,
  SignOut,
  Translate,
  Trash,
  Users,
} from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import { mentionNotificationAvailability, requestMentionNotificationPermission } from '../mentionNotifications'
import type { ActiveRoom } from '../models'
import type { Preferences } from '../preferences'
import { Brand } from './Brand'
import { DestroyRoomDialog, RoomConnectionDetails } from './RoomSidePanel'

type Panel = 'details' | 'settings' | 'more' | null

interface RoomTopBarProps {
  room: ActiveRoom
  preferences: Preferences
  connectionState: 'connecting' | 'ready'
  onPreferences: (next: Preferences) => void
  onLeave: () => void
  onDestroy: () => Promise<void> | void
}

export function RoomTopBar({
  room,
  preferences,
  connectionState,
  onPreferences,
  onLeave,
  onDestroy,
}: RoomTopBarProps) {
  const [panel, setPanel] = useState<Panel>(null)
  const [destroyOpen, setDestroyOpen] = useState(false)
  const [copied, setCopied] = useState<'link' | 'pin' | null>(null)
  const [requestingNotifications, setRequestingNotifications] = useState(false)
  const root = useRef<HTMLElement>(null)
  const self = room.members.find((member) => member.id === room.memberId)
  const zh = preferences.locale === 'zh-CN'
  const notificationAvailability = mentionNotificationAvailability()
  const roomLabel = room.fingerprint.replaceAll(' ', '').slice(-4).toUpperCase()
  const isOwner = room.ownerId === room.memberId
  const invitation = `${window.location.origin}/room/${room.roomId}#${room.linkSecret}`
  const pin = room.pin

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

  const copySecret = async (kind: 'link' | 'pin', value: string): Promise<void> => {
    await navigator.clipboard.writeText(value)
    setCopied(kind)
    window.setTimeout(() => setCopied((current) => current === kind ? null : current), 1_600)
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
        <div className="topbar-brand"><Brand /></div>
        <div className="topbar-room-label" aria-label={zh ? `临时会话 ${roomLabel}` : `Temporary room ${roomLabel}`}>
          <span className={`presence-dot${connectionState === 'ready' ? ' is-ready' : ''}`} aria-hidden="true" />
          <span>{zh ? '临时会话' : 'Temporary room'}</span>
          <code>{roomLabel}</code>
        </div>

        <nav className="top-actions" aria-label={zh ? '房间操作' : 'Room controls'}>
          <div className="popover-anchor members-popover-anchor">
            <button className="top-action members-trigger" type="button" aria-label={zh ? `成员与连接，${room.members.length} 人在线` : `Members and connection, ${room.members.length} online`} aria-expanded={panel === 'details'} onClick={() => toggle('details')}>
              <Users /><span>{room.members.length} {zh ? '人在线' : 'online'}</span><CaretDown />
            </button>
            {panel === 'details' ? (
              <section className="popover topbar-dropdown details-popover" aria-label={zh ? '人员列表' : 'Members'}>
                <RoomConnectionDetails room={room} preferences={preferences} connectionState={connectionState} />
              </section>
            ) : null}
          </div>

          <div className="popover-anchor">
            <button className="icon-button top-icon" type="button" aria-label={t(preferences.locale, 'settings')} aria-expanded={panel === 'settings'} onClick={() => toggle('settings')}><GearSix /></button>
            {panel === 'settings' ? (
              <section className="popover topbar-dropdown settings-popover" aria-label={t(preferences.locale, 'settings')}>
                <div className="popover-title"><strong>{t(preferences.locale, 'settings')}</strong><small>{zh ? '按你的习惯调整会话' : 'Tune the room to your preferences'}</small></div>

                <label className="setting-row">
                  <span className="setting-icon"><Palette /></span>
                  <span className="setting-copy"><strong>{zh ? '主题' : 'Theme'}</strong></span>
                  <select aria-label={zh ? '主题' : 'Theme'} value={preferences.theme} onChange={(event) => onPreferences({ ...preferences, theme: event.target.value as Preferences['theme'] })}><option value="system">{zh ? '跟随系统' : 'System'}</option><option value="light">{zh ? '浅色' : 'Light'}</option><option value="dark">{zh ? '深色' : 'Dark'}</option></select>
                </label>
                <label className="setting-row">
                  <span className="setting-icon"><Translate /></span>
                  <span className="setting-copy"><strong>{zh ? '语言' : 'Language'}</strong></span>
                  <select aria-label={zh ? '语言' : 'Language'} value={preferences.locale} onChange={(event) => onPreferences({ ...preferences, locale: event.target.value as Preferences['locale'] })}><option value="zh-CN">简体中文</option><option value="en-US">English</option></select>
                </label>
                <label className="setting-row">
                  <span className="setting-icon"><FileArrowUp /></span>
                  <span className="setting-copy"><strong>{zh ? '文件上限' : 'File limit'}</strong></span>
                  <span className="number-setting"><input aria-label={zh ? '文件上限' : 'File limit'} type="number" min="1" max="256" value={preferences.maxFileSizeMb} onChange={(event) => onPreferences({ ...preferences, maxFileSizeMb: Number(event.target.value) })} /><small>MiB</small></span>
                </label>
                <label className="setting-row">
                  <span className="setting-icon"><Keyboard /></span>
                  <span className="setting-copy"><strong>{zh ? '发送快捷键' : 'Send shortcut'}</strong></span>
                  <select aria-label={zh ? '发送快捷键' : 'Send shortcut'} value={preferences.sendShortcut} onChange={(event) => onPreferences({ ...preferences, sendShortcut: event.target.value as Preferences['sendShortcut'] })}><option value="enter">Enter</option><option value="mod-enter">⌘/Ctrl + Enter</option></select>
                </label>
                <label className="setting-row">
                  <span className="setting-icon"><Rows /></span>
                  <span className="setting-copy"><strong>{zh ? '消息密度' : 'Message density'}</strong></span>
                  <select aria-label={zh ? '消息密度' : 'Message density'} value={preferences.density} onChange={(event) => onPreferences({ ...preferences, density: event.target.value as Preferences['density'] })}><option value="comfortable">{zh ? '舒适' : 'Comfortable'}</option><option value="compact">{zh ? '紧凑' : 'Compact'}</option></select>
                </label>
                <label className="setting-row setting-toggle">
                  <span className="setting-icon"><Clock /></span>
                  <span className="setting-copy"><strong>{zh ? '显示时间' : 'Show timestamps'}</strong></span>
                  <input type="checkbox" checked={preferences.showTimestamps} onChange={(event) => onPreferences({ ...preferences, showTimestamps: event.target.checked })} />
                </label>
                <label className="setting-row setting-toggle notification-setting">
                  <span className="setting-icon"><Bell /></span>
                  <span className="setting-copy"><strong>{t(preferences.locale, 'mentionNotifications')}</strong>{notificationAvailability === 'denied' ? <small>{t(preferences.locale, 'notificationBlocked')}</small> : null}{notificationAvailability === 'unsupported' ? <small>{t(preferences.locale, 'notificationUnsupported')}</small> : null}</span>
                  <input type="checkbox" checked={preferences.mentionNotifications && notificationAvailability === 'granted'} disabled={requestingNotifications || notificationAvailability === 'denied' || notificationAvailability === 'unsupported'} onChange={(event) => void changeMentionNotifications(event.target.checked)} />
                </label>
                <label className="setting-row setting-toggle">
                  <span className="setting-icon"><BookmarkSimple /></span>
                  <span className="setting-copy"><strong>{zh ? '记住昵称' : 'Remember nickname'}</strong></span>
                  <input type="checkbox" checked={preferences.rememberNickname} onChange={(event) => onPreferences({ ...preferences, rememberNickname: event.target.checked, ...(event.target.checked && self ? { nickname: self.nickname } : { nickname: undefined }) })} />
                </label>
              </section>
            ) : null}
          </div>

          <div className="popover-anchor">
            <button className="icon-button top-icon" type="button" aria-label={t(preferences.locale, 'more')} aria-expanded={panel === 'more'} onClick={() => toggle('more')}><DotsThree /></button>
            {panel === 'more' ? (
              <section className="popover topbar-dropdown more-popover" aria-label={t(preferences.locale, 'more')}>
                <div className="popover-title"><strong>{t(preferences.locale, 'more')}</strong><small>{zh ? '邀请与会话操作' : 'Invitation and room actions'}</small></div>
                <button className="menu-row" type="button" onClick={() => void copySecret('link', invitation)}>{copied === 'link' ? <Check /> : <Copy />}<span aria-live="polite">{copied === 'link' ? t(preferences.locale, 'copied') : t(preferences.locale, 'copyLink')}</span></button>
                {pin ? <button className="menu-row" type="button" onClick={() => void copySecret('pin', pin)}>{copied === 'pin' ? <Check /> : <Key />}<span aria-live="polite">{copied === 'pin' ? t(preferences.locale, 'copied') : t(preferences.locale, 'copyPin')}</span></button> : null}
                <span className="menu-separator" aria-hidden="true" />
                <button className="menu-row" type="button" onClick={onLeave}><SignOut /><span>{t(preferences.locale, 'leave')}</span></button>
                {isOwner ? <button className="menu-row is-destructive" type="button" onClick={() => { setPanel(null); setDestroyOpen(true) }}><Trash /><span>{zh ? '销毁房间' : 'Destroy room'}</span></button> : null}
              </section>
            ) : null}
          </div>
        </nav>
      </div>

      <DestroyRoomDialog room={room} preferences={preferences} open={destroyOpen} onClose={() => setDestroyOpen(false)} onDestroy={onDestroy} />
    </header>
  )
}

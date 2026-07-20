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
} from '@phosphor-icons/react'
import { t } from '../i18n'
import type { ActiveRoom, RoomMode } from '../models'
import type { Preferences } from '../preferences'
import { Brand } from './Brand'

type Panel = 'members' | 'mode' | 'security' | 'settings' | 'more' | null

interface RoomTopBarProps {
  room: ActiveRoom
  preferences: Preferences
  onPreferences: (next: Preferences) => void
  onSwitchMode: (mode: RoomMode) => Promise<void> | void
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

export function RoomTopBar({ room, preferences, onPreferences, onSwitchMode, onLeave, onDestroy }: RoomTopBarProps) {
  const [panel, setPanel] = useState<Panel>(null)
  const [remaining, setRemaining] = useState(() => formatRemaining(room.expiresAt))
  const [copied, setCopied] = useState(false)
  const root = useRef<HTMLElement>(null)
  const self = room.members.find((member) => member.id === room.memberId)
  const isOwner = room.ownerId === room.memberId

  useEffect(() => {
    const timer = window.setInterval(() => setRemaining(formatRemaining(room.expiresAt)), 1000)
    return () => window.clearInterval(timer)
  }, [room.expiresAt])

  useEffect(() => {
    const close = (event: MouseEvent): void => {
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
    const invitation = `${window.location.origin}/room/${room.roomId}#${room.linkSecret}`
    await navigator.clipboard.writeText(invitation)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <header className="topbar" ref={root}>
      <Brand tagline={t(preferences.locale, 'tagline')} />
      <div className="room-summary" aria-label="房间状态">
        <span className="secure-dot" />
        <strong>{room.mode === 'p2p' ? t(preferences.locale, 'p2p') : t(preferences.locale, 'turn')}</strong>
        <time>{remaining}</time>
      </div>
      <nav className="top-actions" aria-label="房间控制">
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
                    <span className="avatar" aria-hidden="true">{member.nickname.slice(0, 1).toUpperCase()}</span>
                    <span className="member-copy">
                      <strong>{member.nickname}{member.id === room.memberId ? '（你）' : ''}</strong>
                      {member.isOwner ? <small>{t(preferences.locale, 'owner')}</small> : null}
                      {room.mode === 'p2p' && member.publicIp ? <code>{member.publicIp}</code> : null}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="popover-note">{room.mode === 'p2p' ? t(preferences.locale, 'directIpNotice') : t(preferences.locale, 'relayNotice')}</p>
            </section>
          ) : null}
        </div>

        <div className="popover-anchor">
          <button className="top-action mode-action" type="button" aria-expanded={panel === 'mode'} onClick={() => toggle('mode')}>
            <span className="secure-dot" /><span>{room.mode === 'p2p' ? t(preferences.locale, 'p2p') : t(preferences.locale, 'turn')}</span>
          </button>
          {panel === 'mode' ? (
            <section className="popover mode-popover">
              <div className="popover-title"><strong>{t(preferences.locale, 'switchMode')}</strong></div>
              {(['turn', 'p2p'] as const).map((mode) => (
                <button
                  className="menu-row"
                  key={mode}
                  type="button"
                  disabled={!isOwner || mode === room.mode}
                  onClick={() => { setPanel(null); void onSwitchMode(mode) }}
                >
                  <span><strong>{mode === 'turn' ? t(preferences.locale, 'turn') : t(preferences.locale, 'p2p')}</strong><small>{mode === 'turn' ? t(preferences.locale, 'relayNotice') : t(preferences.locale, 'directIpNotice')}</small></span>
                  {mode === room.mode ? <Check weight="bold" /> : null}
                </button>
              ))}
              {!isOwner ? <p className="popover-note">仅房间所有者可以切换全员模式。</p> : null}
            </section>
          ) : null}
        </div>

        <div className="popover-anchor">
          <button className="icon-button top-icon" type="button" aria-label={t(preferences.locale, 'security')} aria-expanded={panel === 'security'} onClick={() => toggle('security')}><ShieldCheck /></button>
          {panel === 'security' ? (
            <section className="popover security-popover">
              <div className="popover-title"><strong>{t(preferences.locale, 'security')}</strong><span className="status-chip">E2EE</span></div>
              <p>共享密钥指纹</p>
              <code className="fingerprint">{room.fingerprint}</code>
              <p className="popover-note">请通过其他渠道核对指纹。Veilink 不宣称双棘轮或完全前向保密。</p>
              <dl className="security-facts"><div><dt>{t(preferences.locale, 'expires')}</dt><dd>{remaining}</dd></div><div><dt>会话</dt><dd>仅内存</dd></div></dl>
            </section>
          ) : null}
        </div>

        <div className="popover-anchor">
          <button className="icon-button top-icon" type="button" aria-label={t(preferences.locale, 'settings')} aria-expanded={panel === 'settings'} onClick={() => toggle('settings')}><GearSix /></button>
          {panel === 'settings' ? (
            <section className="popover settings-popover">
              <div className="popover-title"><strong>{t(preferences.locale, 'settings')}</strong></div>
              <label>主题<select value={preferences.theme} onChange={(event) => onPreferences({ ...preferences, theme: event.target.value as Preferences['theme'] })}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
              <label>语言<select value={preferences.locale} onChange={(event) => onPreferences({ ...preferences, locale: event.target.value as Preferences['locale'] })}><option value="zh-CN">简体中文</option><option value="en-US">English</option></select></label>
              <label>默认模式<select value={preferences.defaultRoomMode} onChange={(event) => onPreferences({ ...preferences, defaultRoomMode: event.target.value as Preferences['defaultRoomMode'] })}><option value="turn">TURN 中继</option><option value="p2p">P2P 直连</option></select></label>
              <label>文件上限<input type="number" min="1" max="256" value={preferences.maxFileSizeMb} onChange={(event) => onPreferences({ ...preferences, maxFileSizeMb: Number(event.target.value) })} /><span>MiB</span></label>
              <label>发送快捷键<select value={preferences.sendShortcut} onChange={(event) => onPreferences({ ...preferences, sendShortcut: event.target.value as Preferences['sendShortcut'] })}><option value="enter">Enter</option><option value="mod-enter">⌘/Ctrl + Enter</option></select></label>
              <label>消息密度<select value={preferences.density} onChange={(event) => onPreferences({ ...preferences, density: event.target.value as Preferences['density'] })}><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label>
              <label className="checkbox-row"><input type="checkbox" checked={preferences.showTimestamps} onChange={(event) => onPreferences({ ...preferences, showTimestamps: event.target.checked })} />显示时间</label>
              <label className="checkbox-row"><input type="checkbox" checked={preferences.rememberNickname} onChange={(event) => onPreferences({ ...preferences, rememberNickname: event.target.checked, ...(event.target.checked && self ? { nickname: self.nickname } : { nickname: undefined }) })} />记住昵称</label>
            </section>
          ) : null}
        </div>

        <div className="popover-anchor">
          <button className="icon-button top-icon" type="button" aria-label={t(preferences.locale, 'more')} aria-expanded={panel === 'more'} onClick={() => toggle('more')}><DotsThree /></button>
          {panel === 'more' ? (
            <section className="popover more-popover">
              <button className="menu-row" type="button" onClick={() => void copyInvitation()}><Copy /><span>{copied ? t(preferences.locale, 'copied') : t(preferences.locale, 'copyLink')}</span></button>
              <p className="popover-note">复制的邀请链接可能被系统剪贴板历史或云同步保留。</p>
              <button className="menu-row" type="button" onClick={onLeave}><SignOut /><span>{t(preferences.locale, 'leave')}</span></button>
              {isOwner ? <button className="menu-row destructive" type="button" onClick={() => { setPanel(null); void onDestroy() }}><Trash /><span>{t(preferences.locale, 'destroy')}</span></button> : null}
            </section>
          ) : null}
        </div>
      </nav>
    </header>
  )
}

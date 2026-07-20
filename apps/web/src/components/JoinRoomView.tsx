import { Key, ShieldCheck } from '@phosphor-icons/react'
import { useState, type FormEvent } from 'react'
import { t } from '../i18n'
import type { Preferences } from '../preferences'

interface JoinRoomViewProps {
  preferences: Preferences
  hasLinkSecret: boolean
  busy: boolean
  error?: string
  onJoin: (nickname: string, pin: string) => Promise<void> | void
}

export function JoinRoomView({ preferences, hasLinkSecret, busy, error, onJoin }: JoinRoomViewProps) {
  const [nickname, setNickname] = useState(preferences.rememberNickname ? preferences.nickname ?? '' : '')
  const [pin, setPin] = useState('')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (nickname.trim() && /^\d{6}$/u.test(pin) && hasLinkSecret) void onJoin(nickname, pin)
  }

  return (
    <>
      <h1>{t(preferences.locale, 'join')}</h1>
      <p>{hasLinkSecret ? t(preferences.locale, 'joinDescription') : t(preferences.locale, 'linkMissing')}</p>
      <form className="entry-form" onSubmit={submit}>
        <label>{t(preferences.locale, 'nickname')}<input autoComplete="off" maxLength={64} type="text" value={nickname} placeholder={t(preferences.locale, 'nicknamePlaceholder')} onChange={(event) => setNickname(event.target.value)} required /></label>
        <label>{t(preferences.locale, 'pin')}<input autoComplete="one-time-code" inputMode="numeric" pattern="\d{6}" maxLength={6} type="password" value={pin} placeholder={t(preferences.locale, 'pinPlaceholder')} onChange={(event) => setPin(event.target.value.replace(/\D/gu, '').slice(0, 6))} required /></label>
        <div className="privacy-callout"><ShieldCheck /><span>{t(preferences.locale, 'relayNotice')} 所有连接均强制通过中继建立。</span></div>
        {error ? <div className="form-error" role="alert">{error}</div> : null}
        <button className="primary-button" type="submit" disabled={busy || !hasLinkSecret || !nickname.trim() || !/^\d{6}$/u.test(pin)}><Key weight="fill" />{busy ? t(preferences.locale, 'connecting') : t(preferences.locale, 'join')}</button>
      </form>
      <div className="privacy-callout entry-security"><ShieldCheck /><span>PIN 和链接密钥在本机派生 E2EE 密钥；服务器只接收域隔离的认证材料。</span></div>
    </>
  )
}

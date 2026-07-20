import { ArrowsClockwise, Key, ShieldCheck } from '@phosphor-icons/react'
import { useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react'
import { t } from '../i18n'
import type { Preferences } from '../preferences'
import { MemberAvatar } from './MemberAvatar'

interface JoinRoomViewProps {
  preferences: Preferences
  hasLinkSecret: boolean
  busy: boolean
  avatarSeed?: string
  avatarBusy: boolean
  error?: string
  onRegenerateAvatar: () => Promise<void> | void
  onJoin: (nickname: string, pin: string) => Promise<void> | void
}

export function JoinRoomView({ preferences, hasLinkSecret, busy, avatarSeed, avatarBusy, error, onRegenerateAvatar, onJoin }: JoinRoomViewProps) {
  const [nickname, setNickname] = useState(preferences.rememberNickname ? preferences.nickname ?? '' : '')
  const [digits, setDigits] = useState<string[]>(() => Array.from({ length: 6 }, () => ''))
  const inputs = useRef<Array<HTMLInputElement | null>>([])
  const pin = digits.join('')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (nickname.trim() && /^\d{6}$/u.test(pin) && hasLinkSecret) void onJoin(nickname, pin)
  }
  const setDigit = (index: number, rawValue: string): void => {
    const values = rawValue.replace(/\D/gu, '')
    if (!values) {
      setDigits((current) => current.map((digit, digitIndex) => digitIndex === index ? '' : digit))
      return
    }
    setDigits((current) => {
      const next = [...current]
      for (let offset = 0; offset < values.length && index + offset < next.length; offset += 1) {
        next[index + offset] = values[offset] ?? ''
      }
      return next
    })
    inputs.current[Math.min(5, index + values.length)]?.focus()
  }
  const handleKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Backspace' && !digits[index] && index > 0) {
      event.preventDefault()
      setDigits((current) => current.map((digit, digitIndex) => digitIndex === index - 1 ? '' : digit))
      inputs.current[index - 1]?.focus()
    }
    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault()
      inputs.current[index - 1]?.focus()
    }
    if (event.key === 'ArrowRight' && index < 5) {
      event.preventDefault()
      inputs.current[index + 1]?.focus()
    }
  }
  const handlePaste = (event: ClipboardEvent<HTMLInputElement>): void => {
    const pasted = event.clipboardData.getData('text').replace(/\D/gu, '').slice(0, 6)
    if (!pasted) return
    event.preventDefault()
    setDigits(Array.from({ length: 6 }, (_, index) => pasted[index] ?? ''))
    inputs.current[Math.min(5, pasted.length)]?.focus()
  }

  return (
    <>
      <h1>{t(preferences.locale, 'join')}</h1>
      <p>{hasLinkSecret ? t(preferences.locale, 'joinDescription') : t(preferences.locale, 'linkMissing')}</p>
      <form className="entry-form" onSubmit={submit}>
        <div className="avatar-picker">
          {avatarSeed ? <MemberAvatar seed={avatarSeed} label={t(preferences.locale, 'randomAvatar')} className="avatar-preview" /> : <span className="avatar-skeleton" aria-hidden="true" />}
          <div><strong>{t(preferences.locale, 'randomAvatar')}</strong><small>{t(preferences.locale, 'avatarEphemeral')}</small></div>
          <button type="button" className="avatar-refresh" disabled={busy || avatarBusy} onClick={() => void onRegenerateAvatar()}><ArrowsClockwise />{avatarBusy ? t(preferences.locale, 'avatarGenerating') : t(preferences.locale, 'changeAvatar')}</button>
        </div>
        <label>{t(preferences.locale, 'nickname')}<input autoComplete="off" autoCapitalize="words" spellCheck="false" maxLength={64} type="text" value={nickname} placeholder={t(preferences.locale, 'nicknamePlaceholder')} onChange={(event) => setNickname(event.target.value)} required /></label>
        <fieldset className="pin-fieldset">
          <legend>{t(preferences.locale, 'pin')}</legend>
          <div className="pin-inputs">
            {digits.map((digit, index) => (
              <input
                key={index}
                ref={(element) => { inputs.current[index] = element }}
                aria-label={preferences.locale === 'zh-CN' ? `PIN 第 ${index + 1} 位` : `${t(preferences.locale, 'pinDigit')} ${index + 1}`}
                autoComplete="off"
                data-1p-ignore="true"
                enterKeyHint={index === 5 ? 'done' : 'next'}
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={1}
                type="text"
                value={digit}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setDigit(index, event.target.value)}
                onKeyDown={(event) => handleKeyDown(index, event)}
                onPaste={handlePaste}
              />
            ))}
          </div>
        </fieldset>
        {error ? <div className="form-error" role="alert">{error}</div> : null}
        <button className="primary-button" type="submit" disabled={busy || avatarBusy || !avatarSeed || !hasLinkSecret || !nickname.trim() || !/^\d{6}$/u.test(pin)}><Key weight="fill" />{busy ? t(preferences.locale, 'connecting') : t(preferences.locale, 'join')}</button>
      </form>
      <div className="privacy-callout entry-security"><ShieldCheck /><span>PIN 和链接密钥在本机派生 E2EE 密钥；服务器只接收域隔离的认证材料。</span></div>
    </>
  )
}

import { ArrowsClockwise, LockKey } from '@phosphor-icons/react'
import { useState, type FormEvent } from 'react'
import { t } from '../i18n'
import type { Preferences } from '../preferences'
import { MemberAvatar } from './MemberAvatar'

interface CreateRoomViewProps {
  preferences: Preferences
  busy: boolean
  avatarSeed?: string
  avatarBusy: boolean
  error?: string
  onRegenerateAvatar: () => Promise<void> | void
  onCreate: (nickname: string) => Promise<void> | void
}

export function CreateRoomView({ preferences, busy, avatarSeed, avatarBusy, error, onRegenerateAvatar, onCreate }: CreateRoomViewProps) {
  const [nickname, setNickname] = useState(preferences.rememberNickname ? preferences.nickname ?? '' : '')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (nickname.trim()) void onCreate(nickname)
  }

  return (
    <form className="entry-form" onSubmit={submit}>
      <div className="avatar-picker">
        {avatarSeed ? <MemberAvatar seed={avatarSeed} label={t(preferences.locale, 'randomAvatar')} className="avatar-preview" /> : <span className="avatar-skeleton" aria-hidden="true" />}
        <div><strong>{t(preferences.locale, 'randomAvatar')}</strong><small>{t(preferences.locale, 'avatarEphemeral')}</small></div>
        <button type="button" className="avatar-refresh" disabled={busy || avatarBusy} onClick={() => void onRegenerateAvatar()}><ArrowsClockwise />{avatarBusy ? t(preferences.locale, 'avatarGenerating') : t(preferences.locale, 'changeAvatar')}</button>
      </div>
      <label>{t(preferences.locale, 'nickname')}<input autoFocus autoComplete="off" autoCapitalize="words" spellCheck="false" maxLength={64} name="nickname" type="text" value={nickname} placeholder={t(preferences.locale, 'nicknamePlaceholder')} onChange={(event) => setNickname(event.target.value)} required /></label>
      {error ? <div className="form-error" role="alert">{error}</div> : null}
      <button aria-busy={busy} className="primary-button" type="submit" disabled={busy || avatarBusy || !avatarSeed || !nickname.trim()}><LockKey weight="fill" />{t(preferences.locale, 'create')}</button>
    </form>
  )
}

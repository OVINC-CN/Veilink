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
  creationPasswordRequired: boolean
  error?: string
  onRegenerateAvatar: () => Promise<void> | void
  onCreate: (nickname: string, creationPassword?: string) => Promise<void> | void
}

export function CreateRoomView({ preferences, busy, avatarSeed, avatarBusy, creationPasswordRequired, error, onRegenerateAvatar, onCreate }: CreateRoomViewProps) {
  const [nickname, setNickname] = useState(preferences.rememberNickname ? preferences.nickname ?? '' : '')
  const [creationPassword, setCreationPassword] = useState('')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (nickname.trim() && (!creationPasswordRequired || creationPassword)) {
      void onCreate(nickname, creationPasswordRequired ? creationPassword : undefined)
    }
  }

  return (
    <form className="entry-form" onSubmit={submit}>
      <div className="avatar-picker">
        {avatarSeed ? <MemberAvatar seed={avatarSeed} label={t(preferences.locale, 'randomAvatar')} className="avatar-preview" /> : <span className="avatar-skeleton" aria-hidden="true" />}
        <div><strong>{t(preferences.locale, 'randomAvatar')}</strong><small>{t(preferences.locale, 'avatarEphemeral')}</small></div>
        <button type="button" className="avatar-refresh" disabled={busy || avatarBusy} onClick={() => void onRegenerateAvatar()}><ArrowsClockwise />{avatarBusy ? t(preferences.locale, 'avatarGenerating') : t(preferences.locale, 'changeAvatar')}</button>
      </div>
      <label>{t(preferences.locale, 'nickname')}<input autoFocus autoComplete="off" autoCapitalize="words" spellCheck="false" maxLength={64} name="nickname" type="text" value={nickname} placeholder={t(preferences.locale, 'nicknamePlaceholder')} onChange={(event) => setNickname(event.target.value)} required /></label>
      {creationPasswordRequired ? <label>{t(preferences.locale, 'creationPassword')}<input autoComplete="off" maxLength={256} name="creationPassword" type="password" value={creationPassword} placeholder={t(preferences.locale, 'creationPasswordPlaceholder')} onChange={(event) => setCreationPassword(event.target.value)} required /></label> : null}
      {error ? <div className="form-error" role="alert">{error}</div> : null}
      <button aria-busy={busy} className="primary-button" type="submit" disabled={busy || avatarBusy || !avatarSeed || !nickname.trim() || (creationPasswordRequired && !creationPassword)}><LockKey weight="fill" />{t(preferences.locale, 'create')}</button>
    </form>
  )
}

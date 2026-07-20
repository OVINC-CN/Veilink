import { ArrowsClockwise, LockKey, ShieldCheck } from '@phosphor-icons/react'
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
    <>
      <div className="entry-copy">
        <span className="entry-eyebrow"><ShieldCheck weight="fill" />{preferences.locale === 'zh-CN' ? '私密会话' : 'Private session'}</span>
        <h1>{t(preferences.locale, 'createRoom')}</h1>
        <p>{t(preferences.locale, 'createDescription')}</p>
      </div>
      <form className="entry-form" onSubmit={submit}>
        <div className="avatar-picker">
          {avatarSeed ? <MemberAvatar seed={avatarSeed} label={t(preferences.locale, 'randomAvatar')} className="avatar-preview" /> : <span className="avatar-skeleton" aria-hidden="true" />}
          <div><strong>{t(preferences.locale, 'randomAvatar')}</strong><small>{t(preferences.locale, 'avatarEphemeral')}</small></div>
          <button type="button" className="avatar-refresh" disabled={busy || avatarBusy} onClick={() => void onRegenerateAvatar()}><ArrowsClockwise />{avatarBusy ? t(preferences.locale, 'avatarGenerating') : t(preferences.locale, 'changeAvatar')}</button>
        </div>
        <label>{t(preferences.locale, 'nickname')}<input autoFocus autoComplete="off" autoCapitalize="words" spellCheck="false" maxLength={64} name="nickname" type="text" value={nickname} placeholder={t(preferences.locale, 'nicknamePlaceholder')} onChange={(event) => setNickname(event.target.value)} required /></label>
        {error ? <div className="form-error" role="alert">{error}</div> : null}
        <button className="primary-button" type="submit" disabled={busy || avatarBusy || !avatarSeed || !nickname.trim()}><LockKey weight="fill" />{busy ? t(preferences.locale, 'derive') : t(preferences.locale, 'create')}</button>
        <p className="form-footnote">{preferences.locale === 'zh-CN' ? '房间将在倒计时结束后自动销毁，离开后无法恢复。' : 'The room is destroyed automatically when its timer ends and cannot be recovered.'}</p>
      </form>
    </>
  )
}

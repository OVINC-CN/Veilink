import { LockKey, ShieldCheck } from '@phosphor-icons/react'
import { useState, type FormEvent } from 'react'
import { t } from '../i18n'
import type { Preferences } from '../preferences'

interface CreateRoomViewProps {
  preferences: Preferences
  busy: boolean
  error?: string
  onCreate: (nickname: string) => Promise<void> | void
}

export function CreateRoomView({ preferences, busy, error, onCreate }: CreateRoomViewProps) {
  const [nickname, setNickname] = useState(preferences.rememberNickname ? preferences.nickname ?? '' : '')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (nickname.trim()) void onCreate(nickname)
  }

  return (
    <>
      <h1>{t(preferences.locale, 'createRoom')}</h1>
      <p>{t(preferences.locale, 'createDescription')}</p>
      <form className="entry-form" onSubmit={submit}>
        <label>{t(preferences.locale, 'nickname')}<input autoComplete="off" maxLength={64} name="nickname" type="text" value={nickname} placeholder={t(preferences.locale, 'nicknamePlaceholder')} onChange={(event) => setNickname(event.target.value)} required /></label>
        <div className="privacy-callout"><ShieldCheck /><span>{t(preferences.locale, 'relayNotice')} TURN 只能看到连接元数据，无法解密端到端加密内容。</span></div>
        {error ? <div className="form-error" role="alert">{error}</div> : null}
        <button className="primary-button" type="submit" disabled={busy || !nickname.trim()}><LockKey weight="fill" />{busy ? t(preferences.locale, 'derive') : t(preferences.locale, 'create')}</button>
      </form>
    </>
  )
}

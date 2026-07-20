import { LockKey, Network, ShieldCheck } from '@phosphor-icons/react'
import { useState, type FormEvent } from 'react'
import { t } from '../i18n'
import type { RoomMode } from '../models'
import type { Preferences } from '../preferences'

interface CreateRoomViewProps {
  preferences: Preferences
  busy: boolean
  error?: string
  onPreferences?: (next: Preferences) => void
  onCreate: (nickname: string, mode: RoomMode) => Promise<void> | void
}

export function CreateRoomView({ preferences, busy, error, onPreferences, onCreate }: CreateRoomViewProps) {
  const [nickname, setNickname] = useState(preferences.rememberNickname ? preferences.nickname ?? '' : '')
  const [mode, setMode] = useState<RoomMode>(preferences.defaultRoomMode)
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (nickname.trim()) void onCreate(nickname, mode)
  }
  const selectMode = (next: RoomMode): void => {
    setMode(next)
    onPreferences?.({ ...preferences, defaultRoomMode: next })
  }

  return (
    <>
      <h1>{t(preferences.locale, 'createRoom')}</h1>
      <p>{t(preferences.locale, 'createDescription')}</p>
      <form className="entry-form" onSubmit={submit}>
        <label>{t(preferences.locale, 'nickname')}<input autoComplete="off" maxLength={64} name="nickname" type="text" value={nickname} placeholder={t(preferences.locale, 'nicknamePlaceholder')} onChange={(event) => setNickname(event.target.value)} required /></label>
        <label>{t(preferences.locale, 'initialMode')}
          <span className="mode-selector">
            <button className={`mode-option ${mode === 'turn' ? 'selected' : ''}`} type="button" onClick={() => selectMode('turn')}><ShieldCheck /><strong>{t(preferences.locale, 'turn')}</strong><small>{t(preferences.locale, 'relayNotice')}</small></button>
            <button className={`mode-option ${mode === 'p2p' ? 'selected' : ''}`} type="button" onClick={() => selectMode('p2p')}><Network /><strong>{t(preferences.locale, 'p2p')}</strong><small>{t(preferences.locale, 'directIpNotice')}</small></button>
          </span>
        </label>
        {mode === 'p2p' ? <div className="privacy-callout"><Network /><span>{t(preferences.locale, 'directIpNotice')} 切换到 TURN 后也无法撤回已经暴露的地址。</span></div> : <div className="privacy-callout"><LockKey /><span>默认使用中继模式。TURN 只能看到连接元数据，无法解密端到端加密内容。</span></div>}
        {error ? <div className="form-error" role="alert">{error}</div> : null}
        <button className="primary-button" type="submit" disabled={busy || !nickname.trim()}><LockKey weight="fill" />{busy ? t(preferences.locale, 'derive') : t(preferences.locale, 'create')}</button>
      </form>
    </>
  )
}

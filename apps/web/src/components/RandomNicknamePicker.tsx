import { ArrowsClockwise } from '@phosphor-icons/react'
import { t } from '../i18n'
import type { Preferences } from '../preferences'

interface RandomNicknamePickerProps {
  preferences: Preferences
  nickname: string
  disabled: boolean
  onRegenerate: () => void
}

export function RandomNicknamePicker({ preferences, nickname, disabled, onRegenerate }: RandomNicknamePickerProps) {
  return (
    <div className="nickname-picker">
      <div>
        <strong>{t(preferences.locale, 'randomUsername')}</strong>
        <small>{t(preferences.locale, 'usernameEphemeral')}</small>
      </div>
      <code aria-label={t(preferences.locale, 'randomUsername')}>{nickname}</code>
      <button type="button" className="nickname-refresh" disabled={disabled} onClick={onRegenerate}>
        <ArrowsClockwise />
        {t(preferences.locale, 'changeUsername')}
      </button>
    </div>
  )
}

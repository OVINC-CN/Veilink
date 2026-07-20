import { useEffect, useState } from 'react'
import {
  applyTheme,
  loadPreferences,
  savePreferences,
  type Preferences,
} from '../preferences'

export function usePreferences(): [Preferences, (next: Preferences) => void] {
  const [preferences, setPreferencesState] = useState(loadPreferences)

  useEffect(() => {
    applyTheme(preferences.theme)
  }, [preferences.theme])

  const setPreferences = (next: Preferences): void => {
    setPreferencesState(savePreferences(next))
  }

  return [preferences, setPreferences]
}

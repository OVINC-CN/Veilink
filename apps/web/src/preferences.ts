export const PREFERENCES_KEY = 'veilink.preferences.v1'

export type Locale = 'zh-CN' | 'en-US'
export type Theme = 'system' | 'light' | 'dark'
export type SendShortcut = 'enter' | 'mod-enter'
export type Density = 'comfortable' | 'compact'

export interface Preferences {
  locale: Locale
  theme: Theme
  maxFileSizeMb: number
  sendShortcut: SendShortcut
  showTimestamps: boolean
  density: Density
  rememberNickname: boolean
  mentionNotifications: boolean
  notificationPromptDismissed: boolean
  nickname?: string
}

function browserLocale(): Locale {
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

export function defaultPreferences(): Preferences {
  return {
    locale: browserLocale(),
    theme: 'system',
    maxFileSizeMb: 25,
    sendShortcut: 'enter',
    showTimestamps: true,
    density: 'comfortable',
    rememberNickname: false,
    mentionNotifications: false,
    notificationPromptDismissed: false,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function sanitizePreferences(value: unknown): Preferences {
  const defaults = defaultPreferences()
  if (!isRecord(value)) return defaults

  const locale = value.locale === 'en-US' || value.locale === 'zh-CN' ? value.locale : defaults.locale
  const theme = value.theme === 'light' || value.theme === 'dark' || value.theme === 'system'
    ? value.theme
    : defaults.theme
  const maxFileSizeMb = typeof value.maxFileSizeMb === 'number'
    ? Math.min(256, Math.max(1, Math.round(value.maxFileSizeMb)))
    : defaults.maxFileSizeMb
  const sendShortcut = value.sendShortcut === 'mod-enter' || value.sendShortcut === 'enter'
    ? value.sendShortcut
    : defaults.sendShortcut
  const density = value.density === 'compact' || value.density === 'comfortable'
    ? value.density
    : defaults.density
  const rememberNickname = value.rememberNickname === true

  return {
    locale,
    theme,
    maxFileSizeMb,
    sendShortcut,
    showTimestamps: value.showTimestamps !== false,
    density,
    rememberNickname,
    mentionNotifications: value.mentionNotifications === true,
    notificationPromptDismissed: value.notificationPromptDismissed === true,
    ...(rememberNickname && typeof value.nickname === 'string' && value.nickname.length <= 64
      ? { nickname: value.nickname }
      : {}),
  }
}

export function loadPreferences(): Preferences {
  try {
    const serialized = localStorage.getItem(PREFERENCES_KEY)
    return serialized ? sanitizePreferences(JSON.parse(serialized) as unknown) : defaultPreferences()
  } catch {
    return defaultPreferences()
  }
}

export function savePreferences(preferences: Preferences): Preferences {
  const sanitized = sanitizePreferences(preferences)
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(sanitized))
  return sanitized
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

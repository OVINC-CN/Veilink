import { Moon, ShieldCheck, Sun } from '@phosphor-icons/react'
import { t } from '../i18n'
import type { Preferences } from '../preferences'
import { Brand } from './Brand'

export function EntryShell({ preferences, onPreferences, children }: {
  preferences: Preferences
  onPreferences: (next: Preferences) => void
  children: React.ReactNode
}) {
  const nextTheme = preferences.theme === 'system' || preferences.theme === 'light' ? 'dark' : 'light'
  return (
    <div className="entry-shell">
      <header className="entry-header">
        <Brand tagline={t(preferences.locale, 'tagline')} />
        <div className="entry-header-actions">
          <button className="icon-button" type="button" aria-label="切换语言" onClick={() => onPreferences({ ...preferences, locale: preferences.locale === 'zh-CN' ? 'en-US' : 'zh-CN' })}>{preferences.locale === 'zh-CN' ? 'EN' : '中'}</button>
          <button className="icon-button" type="button" aria-label="切换主题" onClick={() => onPreferences({ ...preferences, theme: nextTheme })}>{nextTheme === 'dark' ? <Moon /> : <Sun />}</button>
        </div>
      </header>
      <main className="entry-main">{children}</main>
      <footer className="entry-footer"><ShieldCheck /> 无 Cookie · 无数据库 · 无服务端消息历史</footer>
    </div>
  )
}

import { Moon, ShieldCheck, Sun } from '@phosphor-icons/react'
import type { Preferences } from '../preferences'
import { Brand } from './Brand'

export function EntryShell({ preferences, onPreferences, children }: {
  preferences: Preferences
  onPreferences: (next: Preferences) => void
  children: React.ReactNode
}) {
  const nextTheme = preferences.theme === 'system' || preferences.theme === 'light' ? 'dark' : 'light'
  const zh = preferences.locale === 'zh-CN'
  return (
    <div className="entry-shell">
      <div className="entry-ambient" aria-hidden="true"><span /><span /></div>
      <header className="entry-header">
        <Brand />
        <div className="entry-header-actions">
          <button className="icon-button language-button" type="button" aria-label={zh ? '切换语言' : 'Switch language'} title={zh ? 'Switch to English' : '切换为中文'} onClick={() => onPreferences({ ...preferences, locale: zh ? 'en-US' : 'zh-CN' })}>{zh ? 'EN' : '中'}</button>
          <button className="icon-button" type="button" aria-label={zh ? '切换主题' : 'Switch theme'} title={zh ? '切换主题' : 'Switch theme'} onClick={() => onPreferences({ ...preferences, theme: nextTheme })}>{nextTheme === 'dark' ? <Moon /> : <Sun />}</button>
        </div>
      </header>
      <main className="entry-main">
        <section className="entry-panel">{children}</section>
      </main>
      <footer className="entry-footer"><ShieldCheck weight="fill" /><span>{zh ? '无 Cookie · Redis 仅存信令元数据 · 无服务端消息历史' : 'No cookies · Redis signaling metadata only · No server-side message history'}</span></footer>
    </div>
  )
}

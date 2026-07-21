import { ChatCircleDots, ShieldCheck, UsersThree } from '@phosphor-icons/react'
import markUrl from '../../../../assets/veilink-mark.png'

export function AppRail({ locale, detailsOpen, onDetailsToggle }: {
  locale: 'zh-CN' | 'en-US'
  detailsOpen: boolean
  onDetailsToggle: () => void
}) {
  const zh = locale === 'zh-CN'

  return (
    <aside className="app-rail" aria-label={zh ? 'Veilink 导航' : 'Veilink navigation'}>
      <img className="rail-mark" src={markUrl} alt="Veilink" />
      <span className="rail-wordmark" aria-hidden="true">Veilink</span>
      <nav className="rail-actions" aria-label={zh ? '房间视图' : 'Room views'}>
        <span className="rail-action is-active" aria-current="page" title={zh ? '对话' : 'Conversation'}>
          <ChatCircleDots weight="duotone" />
        </span>
        <button
          className="rail-action"
          type="button"
          aria-label={zh ? '成员与连接' : 'Members and connection'}
          aria-expanded={detailsOpen}
          title={zh ? '成员与连接' : 'Members and connection'}
          onClick={onDetailsToggle}
        >
          <UsersThree weight="duotone" />
        </button>
        <button
          className="rail-action"
          type="button"
          aria-label={zh ? '安全详情' : 'Security details'}
          aria-expanded={detailsOpen}
          title={zh ? '安全详情' : 'Security details'}
          onClick={onDetailsToggle}
        >
          <ShieldCheck weight="duotone" />
        </button>
      </nav>
      <span className="rail-presence" aria-label={zh ? '信令在线' : 'Signaling online'} />
    </aside>
  )
}

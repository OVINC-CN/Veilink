import { ArrowSquareOut, GlobeHemisphereWest, WarningCircle } from '@phosphor-icons/react'

interface LocalLinkCardProps {
  href: string
}

function colorIndex(value: string): number {
  let hash = 0
  for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0
  return Math.abs(hash) % 5
}

export function LocalLinkCard({ href }: LocalLinkCardProps) {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null

  const secure = url.protocol === 'https:'
  return (
    <a className="link-card" href={url.href} target="_blank" rel="noopener noreferrer">
      <span className={`link-glyph link-color-${colorIndex(url.hostname)}`} aria-hidden="true">
        <GlobeHemisphereWest weight="regular" />
      </span>
      <span className="link-card-copy">
        <strong>{url.hostname}</strong>
        <span>{url.pathname === '/' ? '/' : url.pathname}</span>
        <small>{secure ? 'HTTPS' : 'HTTP'} · 本地生成预览</small>
      </span>
      {!secure ? <WarningCircle className="link-warning" aria-label="不安全的 HTTP 链接" /> : null}
      <ArrowSquareOut className="link-open" aria-hidden="true" />
    </a>
  )
}

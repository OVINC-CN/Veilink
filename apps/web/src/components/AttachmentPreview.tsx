import { CaretDown, CheckCircle, DownloadSimple, FilePdf, FilmSlate, ImageSquare, MagnifyingGlass, MusicNotes, SpinnerGap, X, XCircle } from '@phosphor-icons/react'
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../i18n'
import type { AttachmentView } from '../models'
import type { Locale } from '../preferences'

const PdfPreview = lazy(async () => {
  const module = await import('./PdfPreview')
  return { default: module.PdfPreview }
})

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}

function TypeIcon({ mime }: { mime: string }) {
  if (mime === 'application/pdf') return <FilePdf weight="duotone" />
  if (mime.startsWith('image/')) return <ImageSquare weight="duotone" />
  if (mime.startsWith('video/')) return <FilmSlate weight="duotone" />
  return <MusicNotes weight="duotone" />
}

interface AttachmentPreviewProps {
  attachment: AttachmentView
  locale: Locale
  onPreviewOpen?: () => void
}

export function AttachmentPreview({ attachment, locale, onPreviewOpen }: AttachmentPreviewProps) {
  const available = attachment.status === 'ready' || attachment.status === 'partial'
  const imageUrl = attachment.previewable && available && attachment.objectUrl && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(attachment.mime)
    ? attachment.objectUrl
    : undefined
  const previewableVideo = attachment.previewable && available && attachment.objectUrl && ['video/mp4', 'video/webm'].includes(attachment.mime)
  const previewableAudio = attachment.previewable && available && attachment.objectUrl && ['audio/mpeg', 'audio/ogg', 'audio/wav'].includes(attachment.mime)
  const previewablePdf = attachment.previewable && available && attachment.objectUrl && attachment.mime === 'application/pdf'
  const [previewOpen, setPreviewOpen] = useState(false)
  const [recipientsOpen, setRecipientsOpen] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (!previewOpen) return
    if (!imageUrl) {
      setPreviewOpen(false)
      return
    }

    const appShell = document.querySelector<HTMLElement>('.app-shell')
    const openerNode = opener.current
    const hadInert = appShell?.hasAttribute('inert') ?? false
    const previousOverflow = document.body.style.overflow
    if (!hadInert) appShell?.setAttribute('inert', '')
    document.body.style.overflow = 'hidden'
    const focusFrame = window.requestAnimationFrame(() => closeButton.current?.focus())

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setPreviewOpen(false)
        return
      }
      if (event.key !== 'Tab' || !dialog.current) return
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')]
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown)
      if (!hadInert) appShell?.removeAttribute('inert')
      document.body.style.overflow = previousOverflow
      if (openerNode?.isConnected) window.requestAnimationFrame(() => openerNode.focus())
    }
  }, [imageUrl, previewOpen])

  const openPreview = (): void => {
    if (!imageUrl) return
    onPreviewOpen?.()
    setPreviewOpen(true)
  }

  return (
    <>
    <div className="attachment-card">
      {imageUrl ? (
        <button ref={opener} className="attachment-image-button" type="button" aria-label={`${t(locale, 'previewImage')}: ${attachment.name}`} onClick={openPreview}>
          <img src={imageUrl} alt={attachment.name} />
          <span aria-hidden="true"><MagnifyingGlass /></span>
        </button>
      ) : null}
      {previewableVideo ? <video src={attachment.objectUrl} controls preload="metadata" /> : null}
      {previewableAudio ? <audio src={attachment.objectUrl} controls preload="metadata" /> : null}
      {previewablePdf ? <Suspense fallback={null}><PdfPreview url={attachment.objectUrl!} name={attachment.name} /></Suspense> : null}
      {!imageUrl && !previewableVideo && !previewableAudio && !previewablePdf ? (
        <span className="attachment-type"><TypeIcon mime={attachment.mime} /></span>
      ) : null}
      <span className="attachment-copy">
        <strong>{attachment.name}</strong>
        <small>{formatBytes(attachment.size)} · 端到端加密</small>
        {attachment.status === 'sending' || attachment.status === 'receiving' ? (
          <progress className="progress-track" value={attachment.progress} max={1} aria-label={`${Math.round(attachment.progress * 100)}%`} />
        ) : null}
        {attachment.recipients && attachment.recipients.length > 0 ? (
          <button className="attachment-recipients-toggle" type="button" aria-expanded={recipientsOpen} onClick={() => setRecipientsOpen((open) => !open)}>
            {locale === 'zh-CN' ? '接收详情' : 'Delivery details'}
            <CaretDown />
          </button>
        ) : null}
      </span>
      {available && attachment.objectUrl ? (
        <a className="icon-button" href={attachment.objectUrl} download={attachment.name} aria-label={`${t(locale, 'downloadFile')}: ${attachment.name}`}>
          <DownloadSimple />
        </a>
      ) : null}
      {attachment.status === 'rejected' || attachment.status === 'cancelled' ? <XCircle className="attachment-error" /> : null}
      {attachment.status === 'partial' ? <XCircle className="attachment-error" /> : null}
      {recipientsOpen && attachment.recipients ? (
        <div className="attachment-recipients">
          {attachment.recipients.map((recipient) => {
            const active = recipient.status === 'offered' || recipient.status === 'accepted' || recipient.status === 'transferring'
            const label = recipient.status === 'complete'
              ? locale === 'zh-CN' ? '已接收' : 'Received'
              : recipient.status === 'declined'
                ? locale === 'zh-CN' ? '已拒绝' : 'Declined'
                : recipient.status === 'failed'
                  ? locale === 'zh-CN' ? '失败' : 'Failed'
                  : recipient.status === 'cancelled'
                    ? locale === 'zh-CN' ? '已取消' : 'Cancelled'
                    : locale === 'zh-CN' ? '发送中' : 'Sending'
            const speed = recipient.bytesPerSecond > 0 ? `${formatBytes(recipient.bytesPerSecond)}/s` : undefined
            const eta = recipient.etaSeconds !== undefined ? `${recipient.etaSeconds}s` : undefined
            const rtt = recipient.rttMs !== undefined ? `RTT ${recipient.rttMs}ms` : undefined
            return (
              <div className="attachment-recipient" key={recipient.memberId}>
                <span className="attachment-recipient-icon">{active ? <SpinnerGap className="is-spinning" /> : recipient.status === 'complete' ? <CheckCircle weight="fill" /> : <XCircle weight="fill" />}</span>
                <span><strong>{recipient.nickname}</strong><small>{[label, speed, eta, rtt].filter(Boolean).join(' · ')}</small></span>
                {active ? <progress value={recipient.progress} max={1} aria-label={`${recipient.nickname}: ${Math.round(recipient.progress * 100)}%`} /> : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
    {previewOpen && imageUrl ? createPortal(
      <div className="image-lightbox-scrim" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) setPreviewOpen(false) }}>
        <section ref={dialog} className="image-lightbox" role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <header>
            <strong id={titleId}>{attachment.name}</strong>
            <span>
              <a className="icon-button" href={imageUrl} download={attachment.name} aria-label={`${t(locale, 'downloadFile')}: ${attachment.name}`}><DownloadSimple /></a>
              <button ref={closeButton} className="icon-button" type="button" aria-label={t(locale, 'closePreview')} onClick={() => setPreviewOpen(false)}><X /></button>
            </span>
          </header>
          <div className="image-lightbox-stage" onPointerDown={(event) => { if (event.target === event.currentTarget) setPreviewOpen(false) }}><img src={imageUrl} alt={attachment.name} /></div>
        </section>
      </div>,
      document.body,
    ) : null}
    </>
  )
}

import { DownloadSimple, FilePdf, FilmSlate, ImageSquare, MusicNotes, XCircle } from '@phosphor-icons/react'
import type { AttachmentView } from '../models'
import { PdfPreview } from './PdfPreview'

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

export function AttachmentPreview({ attachment }: { attachment: AttachmentView }) {
  const previewableImage = attachment.previewable && attachment.status === 'ready' && attachment.objectUrl && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(attachment.mime)
  const previewableVideo = attachment.previewable && attachment.status === 'ready' && attachment.objectUrl && ['video/mp4', 'video/webm'].includes(attachment.mime)
  const previewableAudio = attachment.previewable && attachment.status === 'ready' && attachment.objectUrl && ['audio/mpeg', 'audio/ogg', 'audio/wav'].includes(attachment.mime)
  const previewablePdf = attachment.previewable && attachment.status === 'ready' && attachment.objectUrl && attachment.mime === 'application/pdf'

  return (
    <div className="attachment-card">
      {previewableImage ? <img src={attachment.objectUrl} alt={attachment.name} /> : null}
      {previewableVideo ? <video src={attachment.objectUrl} controls preload="metadata" /> : null}
      {previewableAudio ? <audio src={attachment.objectUrl} controls preload="metadata" /> : null}
      {previewablePdf ? <PdfPreview url={attachment.objectUrl!} name={attachment.name} /> : null}
      {!previewableImage && !previewableVideo && !previewableAudio && !previewablePdf ? (
        <span className="attachment-type"><TypeIcon mime={attachment.mime} /></span>
      ) : null}
      <span className="attachment-copy">
        <strong>{attachment.name}</strong>
        <small>{formatBytes(attachment.size)} · 端到端加密</small>
        {attachment.status === 'sending' || attachment.status === 'receiving' ? (
          <progress className="progress-track" value={attachment.progress} max={1} aria-label={`${Math.round(attachment.progress * 100)}%`} />
        ) : null}
      </span>
      {attachment.status === 'ready' && attachment.objectUrl ? (
        <a className="icon-button" href={attachment.objectUrl} download={attachment.name} aria-label={`下载 ${attachment.name}`}>
          <DownloadSimple />
        </a>
      ) : null}
      {attachment.status === 'rejected' || attachment.status === 'cancelled' ? <XCircle className="attachment-error" /> : null}
    </div>
  )
}

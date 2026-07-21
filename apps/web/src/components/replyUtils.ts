import {
  MAX_REPLY_EXCERPT_BYTES,
  MAX_REPLY_EXCERPT_CODE_POINTS,
  ReplyReferenceSchema,
  type ReplyPreviewKind,
  type ReplyReference,
} from '../protocol'
import type { ChatMessage, RichNode, RichTextDocument } from '../models'
import type { Locale } from '../preferences'
import { t } from '../i18n'

const encoder = new TextEncoder()
const FORBIDDEN_REPLY_FORMATTING = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu

function nodeText(node: RichNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return ' '
  if (node.type === 'emoji' && typeof node.attrs?.unicode === 'string') return node.attrs.unicode
  if (node.type === 'mention' && typeof node.attrs?.label === 'string') return `@${node.attrs.label}`
  const separator = node.type === 'doc' || node.type === 'bulletList' || node.type === 'orderedList' || node.type === 'listItem' || node.type === 'blockquote' ? ' ' : ''
  return (node.content ?? []).map(nodeText).join(separator)
}

function truncateExcerpt(value: string): string {
  const codePoints = [...value]
  let bytes = 0
  let end = 0
  while (end < codePoints.length && end < MAX_REPLY_EXCERPT_CODE_POINTS) {
    const nextBytes = encoder.encode(codePoints[end]).byteLength
    if (bytes + nextBytes > MAX_REPLY_EXCERPT_BYTES) break
    bytes += nextBytes
    end += 1
  }
  if (end === codePoints.length) return value

  const ellipsis = '…'
  const ellipsisBytes = encoder.encode(ellipsis).byteLength
  while (end > 0 && (end + 1 > MAX_REPLY_EXCERPT_CODE_POINTS || bytes + ellipsisBytes > MAX_REPLY_EXCERPT_BYTES)) {
    end -= 1
    bytes -= encoder.encode(codePoints[end]).byteLength
  }
  return `${codePoints.slice(0, end).join('')}${ellipsis}`
}

export function richTextExcerpt(document: RichTextDocument): string {
  const normalized = nodeText(document).replace(FORBIDDEN_REPLY_FORMATTING, ' ').normalize('NFC').replace(/\s+/gu, ' ').trim()
  return truncateExcerpt(normalized || '…')
}

function attachmentReplyKind(mime: string): ReplyPreviewKind {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (mime === 'application/pdf') return 'pdf'
  return 'file'
}

export function replyReferenceForMessage(message: ChatMessage): ReplyReference {
  const attachment = message.attachments[0]
  return ReplyReferenceSchema.parse({
    messageId: message.messageId,
    senderId: message.senderId,
    senderName: message.senderName,
    sentAt: message.sentAt,
    kind: attachment ? attachmentReplyKind(attachment.mime) : 'text',
    excerpt: attachment ? truncateExcerpt(attachment.name.normalize('NFC')) : richTextExcerpt(message.document),
  })
}

export function replyReferenceKey(reference: ReplyReference): string {
  return `${reference.senderId}:${reference.messageId}`
}

export function formatReplyExcerpt(reference: ReplyReference, locale: Locale): string {
  if (reference.kind === 'text') return reference.excerpt
  const label = reference.kind === 'image'
    ? t(locale, 'replyImage')
    : reference.kind === 'audio'
      ? t(locale, 'replyAudio')
      : reference.kind === 'video'
        ? t(locale, 'replyVideo')
        : reference.kind === 'pdf'
          ? t(locale, 'replyPdf')
          : t(locale, 'replyFile')
  return `${label} · ${reference.excerpt}`
}

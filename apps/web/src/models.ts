import type { DerivedKeys } from './crypto/types'

export interface Member {
  id: string
  nickname: string
  identityPublicKey: string
  joinedAt: number
  isOwner: boolean
}

export interface RichMark {
  type: 'bold' | 'italic' | 'strike' | 'code' | 'link'
  attrs?: { href?: string }
}

export interface RichNode {
  type: string
  attrs?: Record<string, unknown>
  marks?: RichMark[]
  text?: string
  content?: RichNode[]
}

export interface RichTextDocument extends RichNode {
  type: 'doc'
  content: RichNode[]
}

export interface AttachmentView {
  id: string
  name: string
  mime: string
  size: number
  status: 'sending' | 'receiving' | 'ready' | 'rejected' | 'cancelled'
  progress: number
  previewable: boolean
  objectUrl?: string
}

export interface ChatMessage {
  id: string
  senderId: string
  senderName: string
  senderIdentityPublicKey: string
  sentAt: number
  document: RichTextDocument
  attachments: AttachmentView[]
}

export interface ActiveRoom {
  roomId: string
  memberId: string
  ownerId: string
  expiresAt: number
  linkSecret: string
  fingerprint: string
  keys: DerivedKeys
  members: Member[]
}

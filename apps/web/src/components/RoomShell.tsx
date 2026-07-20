import { LockKey, SpinnerGap } from '@phosphor-icons/react'
import { useLayoutEffect, useRef } from 'react'
import { t } from '../i18n'
import type { ActiveRoom, ChatMessage, RichTextDocument } from '../models'
import type { Preferences } from '../preferences'
import { AttachmentPreview } from './AttachmentPreview'
import { ChatComposer } from './ChatComposer'
import { LocalLinkCard } from './LocalLinkCard'
import { MemberAvatar } from './MemberAvatar'
import { RichText } from './RichText'
import { extractLinks } from './richTextUtils'
import { RoomTopBar } from './RoomTopBar'

interface RoomShellProps {
  room: ActiveRoom
  messages: ChatMessage[]
  preferences: Preferences
  connectionState: 'connecting' | 'ready'
  error?: string
  onPreferences: (next: Preferences) => void
  onSend: (document: RichTextDocument) => Promise<void> | void
  onFiles: (files: File[]) => Promise<void> | void
  onLeave: () => void
  onDestroy: () => Promise<void> | void
}

function formatTime(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(timestamp)
}

export function RoomShell(props: RoomShellProps) {
  const { room, messages, preferences } = props
  const messageList = useRef<HTMLElement>(null)
  const nearBottom = useRef(true)
  const previousLastMessageId = useRef<string | undefined>(undefined)
  const lastMessage = messages.at(-1)
  const lastMessageId = lastMessage?.id
  const lastMessageSenderId = lastMessage?.senderId

  useLayoutEffect(() => {
    if (!lastMessageId || previousLastMessageId.current === lastMessageId) return
    previousLastMessageId.current = lastMessageId
    if (lastMessageSenderId !== room.memberId && !nearBottom.current) return
    const frame = window.requestAnimationFrame(() => {
      const list = messageList.current
      if (!list) return
      nearBottom.current = true
      list.scrollTo({ top: list.scrollHeight, behavior: 'auto' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [lastMessageId, lastMessageSenderId, room.memberId])

  const trackScrollPosition = (): void => {
    const list = messageList.current
    if (!list) return
    nearBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight <= 80
  }

  return (
    <div className={`app-shell density-${preferences.density}`}>
      <RoomTopBar
        room={room}
        preferences={preferences}
        onPreferences={props.onPreferences}
        onLeave={props.onLeave}
        onDestroy={props.onDestroy}
      />
      <main className="chat-main">
        <div className="encryption-notice"><LockKey weight="fill" /><span>{t(preferences.locale, 'encryptedNotice')}</span></div>
        <section ref={messageList} className="message-list" aria-live="polite" aria-label="聊天消息" onScroll={trackScrollPosition}>
          {messages.length === 0 ? <div className="empty-state">{t(preferences.locale, 'noMessages')}</div> : null}
          {messages.map((message) => {
            const links = extractLinks(message.document)
            return (
              <article className="message" key={message.id}>
                <MemberAvatar seed={message.senderIdentityPublicKey} className="message-avatar" />
                <div className="message-body">
                  <header>
                    <strong>{message.senderName}</strong>
                    {preferences.showTimestamps ? <time dateTime={new Date(message.sentAt).toISOString()}>{formatTime(message.sentAt, preferences.locale)}</time> : null}
                  </header>
                  <RichText document={message.document} />
                  {links.map((href) => <LocalLinkCard href={href} key={href} />)}
                  {message.attachments.map((attachment) => <AttachmentPreview attachment={attachment} key={attachment.id} />)}
                </div>
              </article>
            )
          })}
        </section>
        <div className="composer-region">
          {props.error ? <div className="room-error" role="alert">{props.error}</div> : null}
          {props.connectionState === 'connecting' ? (
            <div className="connection-status" role="status" aria-live="polite"><SpinnerGap /><span>{t(preferences.locale, 'connectionPending')}</span></div>
          ) : null}
          <ChatComposer
            connectionState={props.connectionState}
            preferences={preferences}
            placeholder={props.connectionState === 'ready' ? t(preferences.locale, 'composer') : t(preferences.locale, 'composerConnecting')}
            sendLabel={t(preferences.locale, 'send')}
            onSend={props.onSend}
            onFiles={props.onFiles}
          />
        </div>
      </main>
    </div>
  )
}

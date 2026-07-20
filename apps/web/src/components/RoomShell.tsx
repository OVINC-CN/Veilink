import { LockKey } from '@phosphor-icons/react'
import { useEffect, useRef } from 'react'
import { t } from '../i18n'
import type { ActiveRoom, ChatMessage, RichTextDocument, RoomMode } from '../models'
import type { Preferences } from '../preferences'
import { AttachmentPreview } from './AttachmentPreview'
import { ChatComposer } from './ChatComposer'
import { LocalLinkCard } from './LocalLinkCard'
import { RichText } from './RichText'
import { extractLinks } from './richTextUtils'
import { RoomTopBar } from './RoomTopBar'

interface RoomShellProps {
  room: ActiveRoom
  messages: ChatMessage[]
  preferences: Preferences
  connected: boolean
  error?: string
  onPreferences: (next: Preferences) => void
  onSend: (document: RichTextDocument) => Promise<void> | void
  onFiles: (files: File[]) => Promise<void> | void
  onSwitchMode: (mode: RoomMode) => Promise<void> | void
  onLeave: () => void
  onDestroy: () => Promise<void> | void
}

function formatTime(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(timestamp)
}

export function RoomShell(props: RoomShellProps) {
  const { room, messages, preferences } = props
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  return (
    <div className={`app-shell density-${preferences.density}`}>
      <RoomTopBar
        room={room}
        preferences={preferences}
        onPreferences={props.onPreferences}
        onSwitchMode={props.onSwitchMode}
        onLeave={props.onLeave}
        onDestroy={props.onDestroy}
      />
      <main className="chat-main">
        <div className="encryption-notice"><LockKey weight="fill" /><span>{t(preferences.locale, 'encryptedNotice')}</span></div>
        <section className="message-list" aria-live="polite" aria-label="聊天消息">
          {messages.length === 0 ? <div className="empty-state">{t(preferences.locale, 'noMessages')}</div> : null}
          {messages.map((message) => {
            const member = room.members.find((candidate) => candidate.id === message.senderId)
            const links = extractLinks(message.document)
            return (
              <article className="message" key={message.id}>
                <span className="avatar message-avatar" aria-hidden="true">{message.senderName.slice(0, 1).toUpperCase()}</span>
                <div className="message-body">
                  <header>
                    <strong>{message.senderName}</strong>
                    {room.mode === 'p2p' && member?.publicIp ? <code>{member.publicIp}</code> : null}
                    {preferences.showTimestamps ? <time dateTime={new Date(message.sentAt).toISOString()}>{formatTime(message.sentAt, preferences.locale)}</time> : null}
                  </header>
                  <RichText document={message.document} />
                  {links.map((href) => <LocalLinkCard href={href} key={href} />)}
                  {message.attachments.map((attachment) => <AttachmentPreview attachment={attachment} key={attachment.id} />)}
                </div>
              </article>
            )
          })}
          <div ref={end} />
        </section>
        <div className="composer-region">
          {props.error ? <div className="room-error" role="alert">{props.error}</div> : null}
          <ChatComposer
            disabled={!props.connected}
            preferences={preferences}
            placeholder={t(preferences.locale, 'composer')}
            sendLabel={t(preferences.locale, 'send')}
            onSend={props.onSend}
            onFiles={props.onFiles}
          />
          <p>{room.mode === 'p2p' ? t(preferences.locale, 'directIpNotice') : t(preferences.locale, 'relayNotice')}</p>
        </div>
      </main>
    </div>
  )
}

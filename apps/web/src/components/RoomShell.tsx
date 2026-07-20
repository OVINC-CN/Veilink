import { ArrowBendUpLeft, ArrowDown, CaretRight, LockKey, ShieldCheck, SpinnerGap } from '@phosphor-icons/react'
import type { ReplyReference } from '@veilink/protocol'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { formatReplyExcerpt, replyReferenceForMessage, replyReferenceKey } from './replyUtils'

interface RoomShellProps {
  room: ActiveRoom
  messages: ChatMessage[]
  preferences: Preferences
  connectionState: 'connecting' | 'ready'
  error?: string
  onPreferences: (next: Preferences) => void
  onSend: (document: RichTextDocument, replyTo?: ReplyReference) => Promise<void> | void
  onFiles: (files: File[], replyTo?: ReplyReference) => Promise<boolean> | boolean
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
  const messageNodes = useRef(new Map<string, HTMLElement>())
  const highlightTimer = useRef<number | undefined>(undefined)
  const [unreadCount, setUnreadCount] = useState(0)
  const [replyTo, setReplyTo] = useState<ReplyReference>()
  const [highlightedMessageId, setHighlightedMessageId] = useState<string>()
  const lastMessage = messages.at(-1)
  const lastMessageId = lastMessage?.id
  const lastMessageSenderId = lastMessage?.senderId
  const messagesByReference = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages])

  useEffect(() => () => {
    if (highlightTimer.current !== undefined) window.clearTimeout(highlightTimer.current)
  }, [])

  useLayoutEffect(() => {
    if (!lastMessageId || previousLastMessageId.current === lastMessageId) return
    previousLastMessageId.current = lastMessageId
    if (lastMessageSenderId !== room.memberId && !nearBottom.current) {
      setUnreadCount((count) => count + 1)
      return
    }
    const frame = window.requestAnimationFrame(() => {
      const list = messageList.current
      if (!list) return
      nearBottom.current = true
      setUnreadCount(0)
      list.scrollTo({ top: list.scrollHeight, behavior: 'auto' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [lastMessageId, lastMessageSenderId, room.memberId])

  const trackScrollPosition = (): void => {
    const list = messageList.current
    if (!list) return
    nearBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight <= 80
    if (nearBottom.current) setUnreadCount(0)
  }

  const scrollToLatest = (): void => {
    const list = messageList.current
    if (!list) return
    nearBottom.current = true
    setUnreadCount(0)
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' })
  }

  const jumpToMessage = (reference: ReplyReference): void => {
    const key = replyReferenceKey(reference)
    const node = messageNodes.current.get(key)
    if (!node) return
    const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    node.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' })
    setHighlightedMessageId(key)
    if (highlightTimer.current !== undefined) window.clearTimeout(highlightTimer.current)
    highlightTimer.current = window.setTimeout(() => {
      setHighlightedMessageId((current) => current === key ? undefined : current)
      highlightTimer.current = undefined
    }, reduceMotion ? 1 : 1_600)
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
        <section ref={messageList} className="message-list" aria-live="polite" aria-label={preferences.locale === 'zh-CN' ? '聊天消息' : 'Chat messages'} onScroll={trackScrollPosition}>
          {messages.length === 0 ? (
            <div className="empty-state">
              <span className="empty-state-icon"><ShieldCheck weight="duotone" /></span>
              <strong>{preferences.locale === 'zh-CN' ? '从第一条消息开始' : 'Start with the first message'}</strong>
              <span>{t(preferences.locale, 'noMessages')}</span>
            </div>
          ) : null}
          {messages.map((message) => {
            const links = extractLinks(message.document)
            const isSelf = message.senderId === room.memberId
            const messageKey = message.id
            const isReplyTarget = replyTo ? replyReferenceKey(replyTo) === messageKey : false
            const sourceMessage = message.replyTo ? messagesByReference.get(replyReferenceKey(message.replyTo)) : undefined
            const displayedReply = sourceMessage ? replyReferenceForMessage(sourceMessage) : message.replyTo
            return (
              <article
                className={`message${isSelf ? ' message-self' : ''}${isReplyTarget ? ' is-reply-target' : ''}${highlightedMessageId === messageKey ? ' is-highlighted' : ''}`}
                key={message.id}
                ref={(node) => {
                  if (node) messageNodes.current.set(messageKey, node)
                  else messageNodes.current.delete(messageKey)
                }}
              >
                <MemberAvatar seed={message.senderIdentityPublicKey} className="message-avatar" />
                <div className="message-body">
                  <header>
                    <strong>{isSelf ? (preferences.locale === 'zh-CN' ? '你' : 'You') : message.senderName}</strong>
                    {preferences.showTimestamps ? <time dateTime={new Date(message.sentAt).toISOString()}>{formatTime(message.sentAt, preferences.locale)}</time> : null}
                  </header>
                  <div className="message-content">
                    {displayedReply ? (
                      sourceMessage ? (
                        <button
                          className="message-reply-reference"
                          type="button"
                          aria-label={`${t(preferences.locale, 'jumpToReply')}: ${displayedReply.senderName}`}
                          onClick={() => jumpToMessage(displayedReply)}
                        >
                          <span className="reply-reference-copy">
                            <strong>{displayedReply.senderName}</strong>
                            <span>{formatReplyExcerpt(displayedReply, preferences.locale)}</span>
                          </span>
                          <CaretRight aria-hidden="true" />
                        </button>
                      ) : (
                        <div className="message-reply-reference is-unavailable" aria-label={t(preferences.locale, 'replyUnavailable')}>
                          <span className="reply-reference-copy">
                            <strong>{displayedReply.senderName}</strong>
                            <span>{formatReplyExcerpt(displayedReply, preferences.locale)}</span>
                          </span>
                          <small>{t(preferences.locale, 'replyUnavailable')}</small>
                        </div>
                      )
                    ) : null}
                    <RichText document={message.document} />
                    {links.map((href) => <LocalLinkCard href={href} key={href} />)}
                    {message.attachments.map((attachment) => <AttachmentPreview attachment={attachment} key={attachment.id} />)}
                  </div>
                </div>
                <div className="message-actions">
                  <button
                    type="button"
                    aria-label={`${t(preferences.locale, 'replyAction')}: ${message.senderName}`}
                    title={t(preferences.locale, 'replyAction')}
                    onClick={() => setReplyTo(replyReferenceForMessage(message))}
                  >
                    <ArrowBendUpLeft weight="bold" />
                    <span>{t(preferences.locale, 'replyAction')}</span>
                  </button>
                </div>
              </article>
            )
          })}
        </section>
        {unreadCount > 0 ? (
          <button className="jump-to-latest" type="button" onClick={scrollToLatest}>
            <ArrowDown weight="bold" />
            <span>{preferences.locale === 'zh-CN' ? `${unreadCount} 条新消息` : `${unreadCount} new ${unreadCount === 1 ? 'message' : 'messages'}`}</span>
          </button>
        ) : null}
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
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(undefined)}
            onReplyConsumed={(consumed) => setReplyTo((current) => current && replyReferenceKey(current) === replyReferenceKey(consumed) ? undefined : current)}
            onSend={props.onSend}
            onFiles={props.onFiles}
          />
        </div>
      </main>
    </div>
  )
}

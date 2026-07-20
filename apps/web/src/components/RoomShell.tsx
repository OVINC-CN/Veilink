import { ArrowBendUpLeft, ArrowDown, Bell, CaretRight, LockKey, ShieldCheck, SpinnerGap, X } from '@phosphor-icons/react'
import type { ReplyReference } from '@veilink/protocol'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../i18n'
import type { ActiveRoom, ChatMessage, RichTextDocument } from '../models'
import type { Preferences } from '../preferences'
import { mentionNotificationAvailability, requestMentionNotificationPermission } from '../mentionNotifications'
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

interface MessageMenuState {
  messageId: string
  anchorX: number
  left: number
  top: number
}

interface LongPressState {
  pointerId: number
  messageId: string
  startX: number
  startY: number
  timer: number
}

function isMessageBlankTarget(currentTarget: HTMLElement, target: EventTarget): boolean {
  return target === currentTarget || (target instanceof HTMLElement && target.classList.contains('message-body'))
}

function messageMenuPosition(messageRect: DOMRect, anchorX: number, width = 180, height = 50): { left: number; top: number } {
  const edge = 8
  const gap = 7
  const left = Math.min(Math.max(anchorX - width / 2, edge), Math.max(edge, window.innerWidth - width - edge))
  const above = messageRect.top - height - gap
  const top = above >= edge ? above : Math.min(messageRect.bottom + gap, window.innerHeight - height - edge)
  return { left: Math.round(left), top: Math.round(Math.max(edge, top)) }
}

export function RoomShell(props: RoomShellProps) {
  const { room, messages, preferences } = props
  const messageList = useRef<HTMLElement>(null)
  const nearBottom = useRef(true)
  const previousLastMessageId = useRef<string | undefined>(undefined)
  const messageNodes = useRef(new Map<string, HTMLElement>())
  const highlightTimer = useRef<number | undefined>(undefined)
  const longPress = useRef<LongPressState | undefined>(undefined)
  const messageMenuNode = useRef<HTMLDivElement>(null)
  const [unreadCount, setUnreadCount] = useState(0)
  const [replyTo, setReplyTo] = useState<ReplyReference>()
  const [highlightedMessageId, setHighlightedMessageId] = useState<string>()
  const [pressingMessageId, setPressingMessageId] = useState<string>()
  const [messageMenu, setMessageMenu] = useState<MessageMenuState>()
  const [requestingNotifications, setRequestingNotifications] = useState(false)
  const lastMessage = messages.at(-1)
  const lastMessageId = lastMessage?.id
  const lastMessageSenderId = lastMessage?.senderId
  const messagesByReference = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages])

  const clearLongPress = useCallback((): void => {
    if (longPress.current) window.clearTimeout(longPress.current.timer)
    longPress.current = undefined
    setPressingMessageId(undefined)
  }, [])

  const closeMessageMenu = useCallback((): void => {
    clearLongPress()
    setMessageMenu(undefined)
  }, [clearLongPress])

  useEffect(() => () => {
    if (highlightTimer.current !== undefined) window.clearTimeout(highlightTimer.current)
    if (longPress.current) window.clearTimeout(longPress.current.timer)
    longPress.current = undefined
  }, [])

  useEffect(() => {
    if (!messageMenu) return
    const outside = (event: globalThis.PointerEvent): void => {
      if (!messageMenuNode.current?.contains(event.target as Node)) closeMessageMenu()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeMessageMenu()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', closeMessageMenu)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', closeMessageMenu)
    }
  }, [closeMessageMenu, messageMenu])

  useEffect(() => {
    if (messageMenu && !messages.some((message) => message.id === messageMenu.messageId)) closeMessageMenu()
  }, [closeMessageMenu, messageMenu, messages])

  useLayoutEffect(() => {
    if (!messageMenu) return
    const source = messageNodes.current.get(messageMenu.messageId)
    const menu = messageMenuNode.current
    if (!source || !menu) return
    const menuRect = menu.getBoundingClientRect()
    const position = messageMenuPosition(source.getBoundingClientRect(), messageMenu.anchorX, menuRect.width, menuRect.height)
    if (position.left !== messageMenu.left || position.top !== messageMenu.top) {
      setMessageMenu({ ...messageMenu, ...position })
    }
  }, [messageMenu])

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
    closeMessageMenu()
    const list = messageList.current
    if (!list) return
    nearBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight <= 80
    if (nearBottom.current) setUnreadCount(0)
  }

  const startLongPress = (event: ReactPointerEvent<HTMLElement>, message: ChatMessage): void => {
    if (event.pointerType !== 'touch' || !isMessageBlankTarget(event.currentTarget, event.target)) return
    clearLongPress()
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* Pointer capture is optional. */ }
    const messageRect = event.currentTarget.getBoundingClientRect()
    const anchorX = event.clientX
    const position = messageMenuPosition(messageRect, anchorX)
    setPressingMessageId(message.id)
    const timer = window.setTimeout(() => {
      longPress.current = undefined
      setPressingMessageId(undefined)
      setMessageMenu({ messageId: message.id, anchorX, ...position })
    }, 450)
    longPress.current = {
      pointerId: event.pointerId,
      messageId: message.id,
      startX: event.clientX,
      startY: event.clientY,
      timer,
    }
  }

  const moveLongPress = (event: ReactPointerEvent<HTMLElement>): void => {
    const active = longPress.current
    if (!active || active.pointerId !== event.pointerId) return
    if (Math.hypot(event.clientX - active.startX, event.clientY - active.startY) > 10) clearLongPress()
  }

  const finishLongPress = (event: ReactPointerEvent<HTMLElement>): void => {
    if (longPress.current?.pointerId === event.pointerId) clearLongPress()
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

  const notificationAvailability = mentionNotificationAvailability()
  const showNotificationPrompt = !preferences.notificationPromptDismissed &&
    !preferences.mentionNotifications &&
    (notificationAvailability === 'default' || notificationAvailability === 'granted')

  const enableMentionNotifications = async (): Promise<void> => {
    setRequestingNotifications(true)
    const permission = notificationAvailability === 'granted'
      ? 'granted'
      : await requestMentionNotificationPermission()
    props.onPreferences({
      ...preferences,
      mentionNotifications: permission === 'granted',
      notificationPromptDismissed: true,
    })
    setRequestingNotifications(false)
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
        {showNotificationPrompt ? (
          <aside className="notification-prompt" aria-labelledby="notification-prompt-title">
            <Bell weight="duotone" aria-hidden="true" />
            <span>
              <strong id="notification-prompt-title">{t(preferences.locale, 'notificationPromptTitle')}</strong>
              <small>{t(preferences.locale, 'notificationPromptBody')}</small>
            </span>
            <button type="button" className="notification-enable" disabled={requestingNotifications} onClick={() => void enableMentionNotifications()}>{t(preferences.locale, 'enableNotifications')}</button>
            <button type="button" className="notification-dismiss" aria-label={preferences.locale === 'zh-CN' ? '不再提示' : 'Dismiss'} onClick={() => props.onPreferences({ ...preferences, notificationPromptDismissed: true })}><X /></button>
          </aside>
        ) : null}
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
                className={`message${isSelf ? ' message-self' : ''}${isReplyTarget ? ' is-reply-target' : ''}${highlightedMessageId === messageKey ? ' is-highlighted' : ''}${pressingMessageId === messageKey ? ' is-pressing' : ''}${messageMenu?.messageId === messageKey ? ' is-context-open' : ''}`}
                key={message.id}
                ref={(node) => {
                  if (node) messageNodes.current.set(messageKey, node)
                  else messageNodes.current.delete(messageKey)
                }}
                onPointerDown={(event) => startLongPress(event, message)}
                onPointerMove={moveLongPress}
                onPointerUp={finishLongPress}
                onPointerCancel={finishLongPress}
                onLostPointerCapture={finishLongPress}
                onContextMenu={(event) => {
                  if (window.matchMedia('(pointer: coarse)').matches && isMessageBlankTarget(event.currentTarget, event.target)) event.preventDefault()
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
                    {message.attachments.map((attachment) => <AttachmentPreview attachment={attachment} locale={preferences.locale} onPreviewOpen={closeMessageMenu} key={attachment.id} />)}
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
            members={room.members}
            currentMemberId={room.memberId}
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
      {messageMenu ? createPortal(
        <div
          ref={messageMenuNode}
          className="message-context-menu"
          role="menu"
          aria-label={preferences.locale === 'zh-CN' ? '消息操作' : 'Message actions'}
          style={{ left: messageMenu.left, top: messageMenu.top }}
        >
          <button
            type="button"
            role="menuitem"
            autoFocus
            onClick={() => {
              const message = messages.find((item) => item.id === messageMenu.messageId)
              if (message) setReplyTo(replyReferenceForMessage(message))
              closeMessageMenu()
            }}
          >
            <ArrowBendUpLeft weight="bold" />
            <span>{t(preferences.locale, 'replyAction')}</span>
          </button>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}

import { isSafeHttpUrl, type ReplyReference } from '@veilink/protocol'
import { EditorContent, ReactRenderer, useEditor } from '@tiptap/react'
import Link from '@tiptap/extension-link'
import Mention, { type MentionNodeAttrs } from '@tiptap/extension-mention'
import StarterKit from '@tiptap/starter-kit'
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'
import {
  ArrowBendUpLeft,
  Code,
  LinkSimple,
  ListBullets,
  PaperPlaneTilt,
  Paperclip,
  Quotes,
  Smiley,
  TextB,
  TextItalic,
  X,
} from '@phosphor-icons/react'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react'
import type { Member, RichTextDocument } from '../models'
import type { Locale, Preferences } from '../preferences'
import { t } from '../i18n'
import { MentionMenu, type MentionMenuHandle, type MentionMenuProps } from './MentionMenu'
import { formatReplyExcerpt } from './replyUtils'
import { prepareDocumentForWire } from './richTextUtils'

interface ChatComposerProps {
  connectionState: 'connecting' | 'ready'
  preferences: Preferences
  placeholder: string
  sendLabel: string
  members: Member[]
  currentMemberId: string
  replyTo?: ReplyReference
  onCancelReply: () => void
  onReplyConsumed: (replyTo: ReplyReference) => void
  onSend: (document: RichTextDocument, replyTo?: ReplyReference) => Promise<void> | void
  onFiles: (files: File[], replyTo?: ReplyReference) => Promise<boolean> | boolean
}

interface ToolbarButtonProps {
  label: string
  active?: boolean
  disabled: boolean
  expanded?: boolean
  children: ReactNode
  onActivate: () => void
}

function filesFromClipboard(clipboard: DataTransfer): File[] {
  const itemFiles = [...clipboard.items]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
  const clipboardFiles = itemFiles.length > 0 ? itemFiles : [...clipboard.files]
  const timestamp = Date.now()
  return clipboardFiles.map((file, index) => file.name
    ? file
    : new File([file], `pasted-file-${timestamp}-${index + 1}`, {
        type: file.type,
        lastModified: file.lastModified,
      }))
}

function ToolbarButton({ label, active, disabled, expanded, children, onActivate }: ToolbarButtonProps) {
  const activate = (event: PointerEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    if (!disabled) onActivate()
  }

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      aria-expanded={expanded}
      onPointerDown={activate}
      onClick={(event) => { if (event.detail === 0 && !disabled) onActivate() }}
    >
      {children}
    </button>
  )
}

export function ChatComposer({ connectionState, preferences, placeholder, sendLabel, members, currentMemberId, replyTo, onCancelReply, onReplyConsumed, onSend, onFiles }: ChatComposerProps) {
  const disabled = connectionState !== 'ready'
  const root = useRef<HTMLDivElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const emojiAnchor = useRef<HTMLDivElement>(null)
  const emojiMenu = useRef<HTMLDivElement>(null)
  const savedSelection = useRef<{ from: number; to: number } | undefined>(undefined)
  const membersRef = useRef(members)
  const localeRef = useRef<Locale>(preferences.locale)
  const mentionOpenRef = useRef(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [emojiPosition, setEmojiPosition] = useState<{ left: number; top: number }>()
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('https://')
  const [linkError, setLinkError] = useState<string>()
  membersRef.current = members
  localeRef.current = preferences.locale

  const setMentionMenuOpen = (open: boolean): void => {
    mentionOpenRef.current = open
  }

  const mentionExtension = Mention.configure({
    HTMLAttributes: { class: 'mention-node' },
    deleteTriggerWithBackspace: true,
    renderText: ({ node }) => `@${String(node.attrs.label ?? node.attrs.id ?? '')}`,
    renderHTML: ({ node, options }) => ['span', options.HTMLAttributes, `@${String(node.attrs.label ?? node.attrs.id ?? '')}`],
    suggestion: {
      char: '@',
      allowedPrefixes: [' '],
      items: ({ query }) => {
        const normalizedQuery = query.normalize('NFC').toLocaleLowerCase(localeRef.current)
        return membersRef.current
          .filter((member) => member.id !== currentMemberId && member.nickname.normalize('NFC').toLocaleLowerCase(localeRef.current).includes(normalizedQuery))
          .sort((left, right) => Number(right.isOwner) - Number(left.isOwner) || left.joinedAt - right.joinedAt)
          .slice(0, 8)
      },
      render: () => {
        let renderer: ReactRenderer<MentionMenuHandle, MentionMenuProps> | undefined
        let latestProps: SuggestionProps<Member, MentionNodeAttrs> | undefined
        let positionFrame: number | undefined
        let dismissed = false

        const updatePosition = (): void => {
          if (dismissed || !renderer || !latestProps?.clientRect) return
          const anchor = latestProps.clientRect()
          const host = renderer.element as HTMLElement
          if (!anchor) {
            host.style.visibility = 'hidden'
            return
          }
          const rect = host.getBoundingClientRect()
          const width = rect.width || 248
          const height = rect.height || 64
          const gap = 8
          const edge = 8
          const left = Math.min(Math.max(anchor.left, edge), Math.max(edge, window.innerWidth - width - edge))
          const above = anchor.top - height - gap
          const top = above >= edge ? above : Math.min(anchor.bottom + gap, window.innerHeight - height - edge)
          host.style.left = `${Math.round(left)}px`
          host.style.top = `${Math.round(Math.max(edge, top))}px`
          host.style.visibility = 'visible'
        }

        const schedulePosition = (): void => {
          if (positionFrame !== undefined) window.cancelAnimationFrame(positionFrame)
          positionFrame = window.requestAnimationFrame(() => {
            positionFrame = undefined
            updatePosition()
          })
        }

        const observePosition = (): void => {
          window.addEventListener('resize', schedulePosition)
          document.addEventListener('scroll', schedulePosition, true)
          document.addEventListener('pointerdown', dismissOutside)
        }

        const stopObservingPosition = (): void => {
          window.removeEventListener('resize', schedulePosition)
          document.removeEventListener('scroll', schedulePosition, true)
          document.removeEventListener('pointerdown', dismissOutside)
          if (positionFrame !== undefined) window.cancelAnimationFrame(positionFrame)
          positionFrame = undefined
        }

        const hideMenu = (): void => {
          dismissed = true
          const editorElement = latestProps?.editor.view.dom
          if (renderer) (renderer.element as HTMLElement).style.visibility = 'hidden'
          editorElement?.setAttribute('aria-expanded', 'false')
          editorElement?.removeAttribute('aria-controls')
          setMentionMenuOpen(false)
        }

        function dismissOutside(event: globalThis.PointerEvent): void {
          const target = event.target as Node
          if (renderer?.element.contains(target) || latestProps?.editor.view.dom.contains(target)) return
          hideMenu()
        }

        return {
          onStart: (props: SuggestionProps<Member, MentionNodeAttrs>) => {
            latestProps = props
            renderer = new ReactRenderer<MentionMenuHandle, MentionMenuProps>(MentionMenu, {
              editor: props.editor,
              props: { ...props, locale: localeRef.current },
              className: 'mention-menu-host',
            })
            renderer.element.id = `mention-menu-${renderer.id}`
            document.body.appendChild(renderer.element)
            props.editor.view.dom.setAttribute('aria-autocomplete', 'list')
            props.editor.view.dom.setAttribute('aria-haspopup', 'listbox')
            props.editor.view.dom.setAttribute('aria-expanded', 'true')
            props.editor.view.dom.setAttribute('aria-controls', renderer.element.id)
            setMentionMenuOpen(true)
            observePosition()
            schedulePosition()
          },
          onUpdate: (props: SuggestionProps<Member, MentionNodeAttrs>) => {
            latestProps = props
            renderer?.updateProps({ ...props, locale: localeRef.current })
            if (!dismissed) schedulePosition()
          },
          onKeyDown: (props: SuggestionKeyDownProps) => {
            if (props.event.key === 'Escape') {
              props.event.preventDefault()
              hideMenu()
              return true
            }
            return dismissed ? false : renderer?.ref?.onKeyDown(props.event) ?? false
          },
          onExit: () => {
            stopObservingPosition()
            const editorElement = latestProps?.editor.view.dom
            editorElement?.setAttribute('aria-expanded', 'false')
            editorElement?.removeAttribute('aria-controls')
            renderer?.element.remove()
            renderer?.destroy()
            renderer = undefined
            latestProps = undefined
            setMentionMenuOpen(false)
          },
        }
      },
    },
  })
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
      mentionExtension,
    ],
    content: '',
    editable: !disabled,
    editorProps: {
      attributes: {
        class: 'composer-editor',
        'aria-label': placeholder,
        'aria-busy': String(disabled),
        autocapitalize: 'sentences',
        autocomplete: 'off',
        enterkeyhint: preferences.sendShortcut === 'enter' ? 'send' : 'enter',
        inputmode: 'text',
        spellcheck: 'true',
      },
      handleKeyDown: (view, event) => {
        if (event.isComposing || view.composing || event.keyCode === 229) return false
        if (mentionOpenRef.current && ['Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) return false
        const modifier = event.metaKey || event.ctrlKey
        const shouldSend = preferences.sendShortcut === 'enter'
          ? event.key === 'Enter' && !event.shiftKey
          : event.key === 'Enter' && modifier
        if (!shouldSend) return false
        event.preventDefault()
        void submit()
        return true
      },
      handlePaste: (_view, event) => {
        if (disabled || !event.clipboardData) return false
        const files = filesFromClipboard(event.clipboardData)
        if (files.length === 0) return false
        event.preventDefault()
        void submitFiles(files)
        return true
      },
    },
  })

  useEffect(() => {
    editor?.setEditable(!disabled)
    if (disabled) {
      setEmojiOpen(false)
      setLinkOpen(false)
    }
  }, [disabled, editor])

  useEffect(() => {
    const close = (event: globalThis.PointerEvent): void => {
      if (root.current && !root.current.contains(event.target as Node)) {
        setEmojiOpen(false)
        setLinkOpen(false)
      }
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (event.defaultPrevented || mentionOpenRef.current) return
      const popoverWasOpen = emojiOpen || linkOpen
      setEmojiOpen(false)
      setLinkOpen(false)
      if (!popoverWasOpen && replyTo) onCancelReply()
      editor?.commands.focus()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [editor, emojiOpen, linkOpen, onCancelReply, replyTo])

  useEffect(() => {
    if (replyTo) editor?.commands.focus('end')
  }, [editor, replyTo])

  useLayoutEffect(() => {
    if (!emojiOpen) {
      setEmojiPosition(undefined)
      return
    }

    const rootNode = root.current
    const toolbarNode = toolbar.current
    const anchorNode = emojiAnchor.current
    const menuNode = emojiMenu.current
    if (!rootNode || !anchorNode || !menuNode) return

    const updatePosition = (): void => {
      const rootRect = rootNode.getBoundingClientRect()
      const anchorRect = anchorNode.getBoundingClientRect()
      const menuRect = menuNode.getBoundingClientRect()
      const edgeGap = 10
      const preferredLeft = anchorRect.left - rootRect.left + (anchorRect.width - menuRect.width) / 2
      const maxLeft = Math.max(edgeGap, rootRect.width - menuRect.width - edgeGap)
      const nextPosition = {
        left: Math.round(Math.min(Math.max(preferredLeft, edgeGap), maxLeft)),
        top: Math.round(anchorRect.top - rootRect.top - menuRect.height - 9),
      }
      setEmojiPosition((current) => current?.left === nextPosition.left && current.top === nextPosition.top ? current : nextPosition)
    }

    updatePosition()
    toolbarNode?.addEventListener('scroll', updatePosition, { passive: true })
    window.addEventListener('resize', updatePosition)
    const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(updatePosition)
    resizeObserver?.observe(rootNode)
    resizeObserver?.observe(anchorNode)

    return () => {
      toolbarNode?.removeEventListener('scroll', updatePosition)
      window.removeEventListener('resize', updatePosition)
      resizeObserver?.disconnect()
    }
  }, [emojiOpen])

  const submit = async (): Promise<void> => {
    if (!editor || editor.isEmpty || disabled) return
    const document = prepareDocumentForWire(editor.getJSON() as RichTextDocument)
    try {
      await onSend(document, replyTo)
      editor.commands.clearContent(true)
      editor.commands.focus()
      setEmojiOpen(false)
      setLinkOpen(false)
      if (replyTo) onReplyConsumed(replyTo)
    } catch {
      // The parent keeps the draft in place and presents the transport error.
    }
  }

  const submitFiles = async (files: File[]): Promise<void> => {
    try {
      const sent = await onFiles(files, replyTo)
      if (sent && replyTo) onReplyConsumed(replyTo)
    } catch {
      // The parent presents the transfer error and keeps the reply context available.
    }
  }

  const rememberSelection = (): void => {
    if (!editor) return
    savedSelection.current = {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    }
  }

  const restoreSelection = () => {
    if (!editor) return undefined
    const chain = editor.chain().focus()
    const selection = savedSelection.current
    return selection ? chain.setTextSelection(selection) : chain
  }

  const openLink = (): void => {
    if (!editor) return
    rememberSelection()
    const previous = editor.getAttributes('link').href as string | undefined
    setLinkValue(previous ?? 'https://')
    setLinkError(undefined)
    setEmojiOpen(false)
    setLinkOpen((open) => !open)
  }

  const applyLink = (): void => {
    const value = linkValue.trim()
    if (!editor || !isSafeHttpUrl(value)) {
      setLinkError(preferences.locale === 'zh-CN' ? '请输入有效的 HTTP(S) 链接' : 'Enter a valid HTTP(S) link')
      return
    }
    const chain = restoreSelection()
    if (!chain) return
    chain.extendMarkRange('link').setLink({ href: new URL(value).href }).run()
    setLinkOpen(false)
    setLinkError(undefined)
  }

  const removeLink = (): void => {
    const chain = restoreSelection()
    if (!chain) return
    chain.extendMarkRange('link').unsetLink().run()
    setLinkOpen(false)
    setLinkError(undefined)
  }

  const toggleEmoji = (): void => {
    rememberSelection()
    setLinkOpen(false)
    setEmojiOpen((open) => !open)
  }

  const insertEmoji = (emoji: string): void => {
    const chain = restoreSelection()
    if (!chain) return
    chain.insertContent(emoji).run()
    setEmojiOpen(false)
  }

  const commandDisabled = (canRun: boolean): boolean => disabled || !editor || !canRun
  const attachmentLabel = preferences.locale === 'zh-CN' ? '添加附件' : 'Add attachment'

  return (
    <div className={`composer-shell${disabled ? ' is-disabled' : ''}`} ref={root} aria-busy={disabled}>
      {replyTo ? (
        <div className="composer-reply" role="status">
          <ArrowBendUpLeft weight="bold" aria-hidden="true" />
          <span className="composer-reply-copy">
            <strong>{t(preferences.locale, 'replyingTo')} <b>{replyTo.senderName}</b></strong>
            <span>{formatReplyExcerpt(replyTo, preferences.locale)}</span>
          </span>
          <button type="button" aria-label={t(preferences.locale, 'cancelReply')} title={t(preferences.locale, 'cancelReply')} onClick={() => { onCancelReply(); editor?.commands.focus() }}>
            <X />
          </button>
        </div>
      ) : null}
      <div ref={toolbar} className="composer-toolbar" aria-label={preferences.locale === 'zh-CN' ? '文本格式' : 'Text formatting'}>
        <div className="toolbar-group">
          <ToolbarButton label={preferences.locale === 'zh-CN' ? '粗体' : 'Bold'} disabled={commandDisabled(Boolean(editor?.can().chain().focus().toggleBold().run()))} active={Boolean(editor?.isActive('bold'))} onActivate={() => editor?.chain().focus().toggleBold().run()}><TextB /></ToolbarButton>
          <ToolbarButton label={preferences.locale === 'zh-CN' ? '斜体' : 'Italic'} disabled={commandDisabled(Boolean(editor?.can().chain().focus().toggleItalic().run()))} active={Boolean(editor?.isActive('italic'))} onActivate={() => editor?.chain().focus().toggleItalic().run()}><TextItalic /></ToolbarButton>
          <div className="toolbar-popover-anchor">
            <ToolbarButton label={preferences.locale === 'zh-CN' ? '链接' : 'Link'} disabled={disabled || !editor} active={Boolean(editor?.isActive('link'))} expanded={linkOpen} onActivate={openLink}><LinkSimple /></ToolbarButton>
          </div>
          <ToolbarButton label={preferences.locale === 'zh-CN' ? '行内代码' : 'Inline code'} disabled={commandDisabled(Boolean(editor?.can().chain().focus().toggleCode().run()))} active={Boolean(editor?.isActive('code'))} onActivate={() => editor?.chain().focus().toggleCode().run()}><Code /></ToolbarButton>
        </div>
        <span className="toolbar-divider" aria-hidden="true" />
        <div className="toolbar-group">
          <ToolbarButton label={preferences.locale === 'zh-CN' ? '项目列表' : 'Bullet list'} disabled={commandDisabled(Boolean(editor?.can().chain().focus().toggleBulletList().run()))} active={Boolean(editor?.isActive('bulletList'))} onActivate={() => editor?.chain().focus().toggleBulletList().run()}><ListBullets /></ToolbarButton>
          <ToolbarButton label={preferences.locale === 'zh-CN' ? '引用' : 'Blockquote'} disabled={commandDisabled(Boolean(editor?.can().chain().focus().toggleBlockquote().run()))} active={Boolean(editor?.isActive('blockquote'))} onActivate={() => editor?.chain().focus().toggleBlockquote().run()}><Quotes /></ToolbarButton>
        </div>
        <span className="toolbar-divider" aria-hidden="true" />
        <div className="toolbar-group">
          <div ref={emojiAnchor} className="toolbar-popover-anchor">
            <ToolbarButton label="Emoji" disabled={disabled || !editor} expanded={emojiOpen} onActivate={toggleEmoji}><Smiley /></ToolbarButton>
          </div>
          <label className={`attachment-picker${disabled ? ' is-disabled' : ''}`} title={attachmentLabel}>
            <Paperclip aria-hidden="true" />
            <input
              type="file"
              multiple
              disabled={disabled}
              aria-label={attachmentLabel}
              onChange={(event) => {
                const files = [...(event.currentTarget.files ?? [])]
                event.currentTarget.value = ''
                if (files.length > 0) void submitFiles(files)
              }}
            />
          </label>
        </div>
      </div>
      {linkOpen ? (
        <div className="composer-popover link-popover" role="dialog" aria-label={preferences.locale === 'zh-CN' ? '编辑链接' : 'Edit link'}>
          <div className="popover-heading"><strong>{preferences.locale === 'zh-CN' ? '链接' : 'Link'}</strong><button type="button" aria-label={preferences.locale === 'zh-CN' ? '关闭' : 'Close'} onClick={() => { setLinkOpen(false); editor?.commands.focus() }}><X /></button></div>
          <input autoFocus type="url" inputMode="url" autoComplete="off" spellCheck="false" value={linkValue} onChange={(event) => { setLinkValue(event.target.value); setLinkError(undefined) }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applyLink() } }} />
          {linkError ? <small className="popover-error" role="alert">{linkError}</small> : null}
          <div className="popover-actions"><button type="button" onClick={removeLink}>{preferences.locale === 'zh-CN' ? '移除' : 'Remove'}</button><button type="button" className="popover-primary" onClick={applyLink}>{preferences.locale === 'zh-CN' ? '应用' : 'Apply'}</button></div>
        </div>
      ) : null}
      {emojiOpen ? (
        <div
          ref={emojiMenu}
          className="composer-popover emoji-menu"
          role="menu"
          aria-label="Emoji"
          style={emojiPosition ?? { visibility: 'hidden' }}
        >
          {['😀', '😂', '🥰', '👍', '👏', '🎉', '🔒', '👀'].map((emoji) => <button key={emoji} type="button" role="menuitem" onClick={() => insertEmoji(emoji)}>{emoji}</button>)}
        </div>
      ) : null}
      <div className="composer-body">
        <EditorContent editor={editor} />
        {!editor || editor.isEmpty ? <span className="composer-placeholder">{placeholder}</span> : null}
        <div className="composer-actions">
          <span className="composer-shortcut" aria-hidden="true"><kbd>{preferences.sendShortcut === 'enter' ? '↵' : '⌘↵'}</kbd></span>
          <button className="send-button" type="button" aria-label={sendLabel} disabled={disabled || !editor || editor.isEmpty} onClick={() => void submit()}>
            <PaperPlaneTilt weight="fill" />
            <span>{sendLabel}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

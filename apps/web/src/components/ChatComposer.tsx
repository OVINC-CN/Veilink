import { isSafeHttpUrl } from '@veilink/protocol'
import { EditorContent, useEditor } from '@tiptap/react'
import Link from '@tiptap/extension-link'
import StarterKit from '@tiptap/starter-kit'
import {
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
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import type { RichTextDocument } from '../models'
import type { Preferences } from '../preferences'

interface ChatComposerProps {
  connectionState: 'connecting' | 'ready'
  preferences: Preferences
  placeholder: string
  sendLabel: string
  onSend: (document: RichTextDocument) => Promise<void> | void
  onFiles: (files: File[]) => Promise<void> | void
}

interface ToolbarButtonProps {
  label: string
  active?: boolean
  disabled: boolean
  expanded?: boolean
  children: ReactNode
  onActivate: () => void
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

export function ChatComposer({ connectionState, preferences, placeholder, sendLabel, onSend, onFiles }: ChatComposerProps) {
  const disabled = connectionState !== 'ready'
  const root = useRef<HTMLDivElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const emojiAnchor = useRef<HTMLDivElement>(null)
  const emojiMenu = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const savedSelection = useRef<{ from: number; to: number } | undefined>(undefined)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [emojiPosition, setEmojiPosition] = useState<{ left: number; top: number }>()
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('https://')
  const [linkError, setLinkError] = useState<string>()
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
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
        const modifier = event.metaKey || event.ctrlKey
        const shouldSend = preferences.sendShortcut === 'enter'
          ? event.key === 'Enter' && !event.shiftKey
          : event.key === 'Enter' && modifier
        if (!shouldSend) return false
        event.preventDefault()
        void submit()
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
      setEmojiOpen(false)
      setLinkOpen(false)
      editor?.commands.focus()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [editor])

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
    const document = editor.getJSON() as RichTextDocument
    try {
      await onSend(document)
      editor.commands.clearContent(true)
      editor.commands.focus()
      setEmojiOpen(false)
      setLinkOpen(false)
    } catch {
      // The parent keeps the draft in place and presents the transport error.
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

  return (
    <div className={`composer-shell${disabled ? ' is-disabled' : ''}`} ref={root} aria-busy={disabled}>
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
          <ToolbarButton label={preferences.locale === 'zh-CN' ? '添加附件' : 'Add attachment'} disabled={disabled} onActivate={() => fileInput.current?.click()}><Paperclip /></ToolbarButton>
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            multiple
            disabled={disabled}
            onChange={(event) => {
              const files = [...(event.target.files ?? [])]
              event.target.value = ''
              if (files.length > 0) void onFiles(files)
            }}
          />
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
        <button className="send-button" type="button" disabled={disabled || !editor || editor.isEmpty} onClick={() => void submit()}>
          <PaperPlaneTilt weight="fill" />
          <span>{sendLabel}</span>
        </button>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
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
} from '@phosphor-icons/react'
import type { RichTextDocument } from '../models'
import type { Preferences } from '../preferences'

interface ChatComposerProps {
  disabled: boolean
  preferences: Preferences
  placeholder: string
  sendLabel: string
  onSend: (document: RichTextDocument) => Promise<void> | void
  onFiles: (files: File[]) => Promise<void> | void
}

export function ChatComposer({ disabled, preferences, placeholder, sendLabel, onSend, onFiles }: ChatComposerProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
    ],
    content: '',
    editable: !disabled,
    editorProps: {
      attributes: { class: 'composer-editor', 'aria-label': placeholder },
      handleKeyDown: (_view, event) => {
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
  }, [disabled, editor])

  const submit = async (): Promise<void> => {
    if (!editor || editor.isEmpty || disabled) return
    const document = editor.getJSON() as RichTextDocument
    try {
      await onSend(document)
      editor.commands.clearContent(true)
      editor.commands.focus()
    } catch {
      // The parent keeps the draft in place and presents the transport error.
    }
  }

  const setLink = (): void => {
    if (!editor) return
    const previous = editor.getAttributes('link').href as string | undefined
    const href = window.prompt('https://', previous ?? 'https://')
    if (href === null) return
    if (!href) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    try {
      const url = new URL(href)
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        editor.chain().focus().extendMarkRange('link').setLink({ href: url.href }).run()
      }
    } catch {
      // Invalid links are ignored and never enter the rich-text document.
    }
  }

  return (
    <div className="composer-shell">
      <div className="composer-toolbar" aria-label="文本格式">
        <button type="button" onClick={() => editor?.chain().focus().toggleBold().run()} aria-label="粗体" aria-pressed={editor?.isActive('bold')}><TextB /></button>
        <button type="button" onClick={() => editor?.chain().focus().toggleItalic().run()} aria-label="斜体" aria-pressed={editor?.isActive('italic')}><TextItalic /></button>
        <button type="button" onClick={setLink} aria-label="链接" aria-pressed={editor?.isActive('link')}><LinkSimple /></button>
        <button type="button" onClick={() => editor?.chain().focus().toggleCode().run()} aria-label="行内代码" aria-pressed={editor?.isActive('code')}><Code /></button>
        <button type="button" onClick={() => editor?.chain().focus().toggleBulletList().run()} aria-label="项目列表" aria-pressed={editor?.isActive('bulletList')}><ListBullets /></button>
        <button type="button" onClick={() => editor?.chain().focus().toggleBlockquote().run()} aria-label="引用" aria-pressed={editor?.isActive('blockquote')}><Quotes /></button>
        <span className="emoji-anchor">
          <button type="button" onClick={() => setEmojiOpen((open) => !open)} aria-label="Emoji" aria-expanded={emojiOpen}><Smiley /></button>
          {emojiOpen ? <span className="emoji-menu" role="menu" aria-label="Emoji">
            {['😀', '😂', '🥰', '👍', '👏', '🎉', '🔒', '👀'].map((emoji) => <button key={emoji} type="button" role="menuitem" onClick={() => { editor?.chain().focus().insertContent(emoji).run(); setEmojiOpen(false) }}>{emoji}</button>)}
          </span> : null}
        </span>
        <button type="button" onClick={() => fileInput.current?.click()} aria-label="添加附件"><Paperclip /></button>
        <input
          ref={fileInput}
          className="visually-hidden"
          type="file"
          multiple
          onChange={(event) => {
            const files = [...(event.target.files ?? [])]
            event.target.value = ''
            if (files.length > 0) void onFiles(files)
          }}
        />
      </div>
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

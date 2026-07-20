import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import type { MentionNodeAttrs } from '@tiptap/extension-mention'
import type { SuggestionProps } from '@tiptap/suggestion'
import type { Member } from '../models'
import type { Locale } from '../preferences'
import { MemberAvatar } from './MemberAvatar'

export interface MentionMenuHandle {
  onKeyDown: (event: KeyboardEvent) => boolean
}

export type MentionMenuProps = SuggestionProps<Member, MentionNodeAttrs> & {
  locale: Locale
}

export const MentionMenu = forwardRef<MentionMenuHandle, MentionMenuProps>(function MentionMenu(props, ref) {
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(0, props.items.length - 1)))
  }, [props.items])

  const select = (index: number): void => {
    const member = props.items[index]
    if (!member) return
    props.command({ id: member.id, label: member.nickname })
  }

  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      if (event.key === 'ArrowUp') {
        if (props.items.length === 0) return true
        event.preventDefault()
        setSelectedIndex((current) => (current + props.items.length - 1) % props.items.length)
        return true
      }
      if (event.key === 'ArrowDown') {
        if (props.items.length === 0) return true
        event.preventDefault()
        setSelectedIndex((current) => (current + 1) % props.items.length)
        return true
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && props.items.length > 0) {
        event.preventDefault()
        select(selectedIndex)
        return true
      }
      return false
    },
  }))

  return (
    <div className="mention-menu" role="listbox" aria-label={props.locale === 'zh-CN' ? '选择要提及的成员' : 'Choose a member to mention'}>
      {props.items.length === 0 ? (
        <span className="mention-menu-empty">{props.locale === 'zh-CN' ? '没有匹配的成员' : 'No matching members'}</span>
      ) : props.items.map((member, index) => (
        <button
          type="button"
          role="option"
          aria-selected={index === selectedIndex}
          className={index === selectedIndex ? 'is-selected' : undefined}
          key={member.id}
          onPointerMove={() => setSelectedIndex(index)}
          onPointerDown={(event) => {
            event.preventDefault()
            select(index)
          }}
        >
          <MemberAvatar seed={member.identityPublicKey} />
          <span>
            <strong>{member.nickname}</strong>
            {member.isOwner ? <small>{props.locale === 'zh-CN' ? '发起人' : 'Host'}</small> : null}
          </span>
        </button>
      ))}
    </div>
  )
})

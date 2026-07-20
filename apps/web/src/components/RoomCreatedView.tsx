import { Check, Copy, Key, LinkSimple, ShieldCheck } from '@phosphor-icons/react'
import { useState } from 'react'
import type { Preferences } from '../preferences'

export function RoomCreatedView({ pin, invitation, preferences, onContinue }: {
  pin: string
  invitation: string
  preferences: Preferences
  onContinue: () => void
}) {
  const [copied, setCopied] = useState<'pin' | 'link' | null>(null)
  const copy = async (kind: 'pin' | 'link', value: string): Promise<void> => {
    await navigator.clipboard.writeText(value)
    setCopied(kind)
    window.setTimeout(() => setCopied(null), 1500)
  }
  const zh = preferences.locale === 'zh-CN'
  return (
    <div className="room-created">
      <div className="entry-copy created-copy">
        <span className="entry-success-mark"><Check weight="bold" /></span>
        <span className="entry-eyebrow"><ShieldCheck weight="fill" />{zh ? '房间已就绪' : 'Room ready'}</span>
        <h1>{zh ? '安全聊天室已创建' : 'Your secure room is ready'}</h1>
        <p>{zh ? '通过两个不同渠道分别分享邀请链接和 PIN。进入房间后，PIN 将不再显示。' : 'Share the invitation link and PIN through two different channels. The PIN will not be shown again.'}</p>
      </div>
      <div className="secret-field secret-pin"><span><Key /> {zh ? '6 位 PIN' : '6-digit PIN'}</span><strong>{pin}</strong><button className="top-action" type="button" onClick={() => void copy('pin', pin)}>{copied === 'pin' ? <Check /> : <Copy />}{copied === 'pin' ? (zh ? '已复制' : 'Copied') : (zh ? '复制 PIN' : 'Copy PIN')}</button></div>
      <div className="secret-field"><span><LinkSimple /> {zh ? '邀请链接' : 'Invitation link'}</span><code>{invitation}</code><button className="top-action" type="button" onClick={() => void copy('link', invitation)}>{copied === 'link' ? <Check /> : <Copy />}{copied === 'link' ? (zh ? '已复制' : 'Copied') : (zh ? '复制链接' : 'Copy link')}</button></div>
      <div className="privacy-callout"><Key /><span>{zh ? '不要在同一条消息中发送链接和 PIN。剪贴板内容可能被历史记录或云同步保留，分享后请手动覆盖。' : 'Do not send the link and PIN in the same message. Clipboard history or cloud sync may retain copied values; overwrite them after sharing.'}</span></div>
      <span className="copy-announcement" role="status" aria-live="polite">{copied ? (zh ? '已复制到剪贴板' : 'Copied to clipboard') : ''}</span>
      <button className="primary-button" type="button" onClick={onContinue}>{zh ? '我已分别保存，进入聊天室' : 'Saved separately — enter room'}</button>
    </div>
  )
}

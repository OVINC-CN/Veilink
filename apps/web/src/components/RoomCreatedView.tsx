import { Check, Copy, Key, LinkSimple } from '@phosphor-icons/react'
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
  return (
    <div className="room-created">
      <h1>聊天室已创建</h1>
      <p>请通过不同渠道分享邀请链接和 PIN。进入房间后 PIN 将不再显示。</p>
      <div className="secret-field"><span><Key /> 6 位 PIN</span><strong>{pin}</strong><button className="top-action" type="button" onClick={() => void copy('pin', pin)}>{copied === 'pin' ? <Check /> : <Copy />}{copied === 'pin' ? '已复制' : '复制 PIN'}</button></div>
      <div className="secret-field"><span><LinkSimple /> 邀请链接</span><code>{invitation}</code><button className="top-action" type="button" onClick={() => void copy('link', invitation)}>{copied === 'link' ? <Check /> : <Copy />}{copied === 'link' ? '已复制' : '复制链接'}</button></div>
      <div className="privacy-callout"><Key /><span>不要在同一条消息中发送链接和 PIN。复制会写入系统剪贴板，可能被剪贴板历史或云同步保留；分享后请手动覆盖。</span></div>
      <button className="primary-button" type="button" onClick={onContinue}>{preferences.locale === 'zh-CN' ? '我已保存，进入聊天室' : 'Saved — enter room'}</button>
    </div>
  )
}

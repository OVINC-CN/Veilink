import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ActiveRoom } from '../models'
import { defaultPreferences } from '../preferences'
import { CreateRoomView } from './CreateRoomView'
import { EntryShell } from './EntryShell'
import { RoomShell } from './RoomShell'

vi.mock('./PdfPreview', () => ({ PdfPreview: () => null }))

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
})

describe('minimal entry experience', () => {
  it('exposes one main region and labelled creation controls', () => {
    const preferences = { ...defaultPreferences(), locale: 'zh-CN' as const }
    const onCreate = vi.fn()
    const { container } = render(
      <EntryShell preferences={preferences} onPreferences={vi.fn()}>
        <CreateRoomView preferences={preferences} busy={false} onCreate={onCreate} />
      </EntryShell>,
    )

    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '创建安全聊天室' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '昵称' })).toHaveAttribute('autocomplete', 'off')
    expect(screen.getByRole('button', { name: '切换语言' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '切换主题' })).toBeInTheDocument()
    expect(container.querySelectorAll('main')).toHaveLength(1)
    expect(container.querySelector('aside')).toBeNull()

    fireEvent.change(screen.getByRole('textbox', { name: '昵称' }), { target: { value: 'Mira' } })
    fireEvent.click(screen.getByRole('button', { name: /创建聊天室/u }))
    expect(onCreate).toHaveBeenCalledWith('Mira', 'turn')
  })
})

describe('selected single-column room layout', () => {
  it('keeps secondary room information behind top-bar buttons', () => {
    const preferences = { ...defaultPreferences(), locale: 'zh-CN' as const }
    const room: ActiveRoom = {
      roomId: 'room-id',
      memberId: 'member-owner',
      ownerId: 'member-owner',
      mode: 'p2p',
      modeVersion: 1,
      expiresAt: Date.now() + 60_000,
      linkSecret: 'link-secret',
      fingerprint: 'ABCD EFGH IJKL MNOP',
      keys: {
        admissionKey: new Uint8Array(32),
        messageKey: new Uint8Array(32),
        fileKey: new Uint8Array(32),
        fingerprintKey: new Uint8Array(32),
        fingerprint: 'ABCD EFGH IJKL MNOP',
      },
      members: [
        {
          id: 'member-owner',
          nickname: 'Mira',
          identityPublicKey: 'public-key',
          joinedAt: 1,
          isOwner: true,
          publicIp: '203.0.113.5',
        },
        {
          id: 'member-two',
          nickname: 'River',
          identityPublicKey: 'public-key-two',
          joinedAt: 2,
          isOwner: false,
          publicIp: '2001:db8::7',
        },
      ],
    }
    const { container } = render(
      <RoomShell
        room={room}
        messages={[]}
        preferences={preferences}
        connected
        onPreferences={vi.fn()}
        onSend={vi.fn()}
        onFiles={vi.fn()}
        onSwitchMode={vi.fn()}
        onLeave={vi.fn()}
        onDestroy={vi.fn()}
      />,
    )

    expect(screen.getByRole('main')).toHaveClass('chat-main')
    expect(screen.getByRole('navigation', { name: '房间控制' })).toBeInTheDocument()
    expect(container.querySelector('aside')).toBeNull()
    expect(screen.queryByText('203.0.113.5')).not.toBeInTheDocument()

    const membersButton = screen.getByRole('button', { name: /成员 2/u })
    expect(membersButton).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(membersButton)
    expect(membersButton).toHaveAttribute('aria-expanded', 'true')

    const membersPanel = screen.getByRole('region', { name: '成员' })
    expect(within(membersPanel).getByText('203.0.113.5')).toBeInTheDocument()
    expect(within(membersPanel).getByText('2001:db8::7')).toBeInTheDocument()
  })
})

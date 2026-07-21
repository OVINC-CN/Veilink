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
        <CreateRoomView preferences={preferences} busy={false} avatarSeed="avatar-seed" avatarBusy={false} creationPasswordRequired={false} onRegenerateAvatar={vi.fn()} onCreate={onCreate} />
      </EntryShell>,
    )

    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.getByText('随机头像')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '昵称' })).toHaveAttribute('autocomplete', 'off')
    expect(screen.getByRole('button', { name: '切换语言' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '切换主题' })).toBeInTheDocument()
    expect(container.querySelectorAll('main')).toHaveLength(1)
    expect(container.querySelector('aside')).toBeNull()

    fireEvent.change(screen.getByRole('textbox', { name: '昵称' }), { target: { value: 'Mira' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(onCreate).toHaveBeenCalledWith('Mira', undefined)
    expect(screen.queryByText('P2P 直连')).not.toBeInTheDocument()
  })

  it('requires and submits the deployment creation password when configured', () => {
    const preferences = { ...defaultPreferences(), locale: 'zh-CN' as const }
    const onCreate = vi.fn()
    render(
      <CreateRoomView preferences={preferences} busy={false} avatarSeed="avatar-seed" avatarBusy={false} creationPasswordRequired onRegenerateAvatar={vi.fn()} onCreate={onCreate} />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: '昵称' }), { target: { value: 'Mira' } })
    const password = screen.getByLabelText('会话创建密码')
    expect(password).toBeRequired()
    expect(screen.getByRole('button', { name: '创建' })).toBeDisabled()
    fireEvent.change(password, { target: { value: 'deployment-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(onCreate).toHaveBeenCalledWith('Mira', 'deployment-secret')
  })
})

describe('room workspace layout', () => {
  it('exposes relay-only connection details without participant IP metadata', () => {
    const preferences = { ...defaultPreferences(), locale: 'zh-CN' as const }
    const room: ActiveRoom = {
      roomId: 'room-id',
      memberId: 'member-owner',
      ownerId: 'member-owner',
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
        },
        {
          id: 'member-two',
          nickname: 'River',
          identityPublicKey: 'public-key-two',
          joinedAt: 2,
          isOwner: false,
        },
      ],
    }
    render(
      <RoomShell
        room={room}
        messages={[]}
        preferences={preferences}
        connectionState="ready"
        onPreferences={vi.fn()}
        onSend={vi.fn()}
        onFiles={vi.fn()}
        onLeave={vi.fn()}
        onDestroy={vi.fn()}
      />,
    )

    expect(screen.getByRole('main')).toHaveClass('chat-main')
    expect(screen.getByRole('navigation', { name: '房间操作' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: '房间视图' })).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Veilink 导航' })).not.toBeInTheDocument()
    expect(screen.queryByText('Cloudflare TURN 中继')).not.toBeInTheDocument()

    const membersButton = screen.getByRole('button', { name: /成员与连接，2 人在线/u })
    expect(membersButton).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(membersButton)
    expect(membersButton).toHaveAttribute('aria-expanded', 'true')

    const detailsPanel = screen.getByRole('region', { name: '人员列表' })
    expect(within(detailsPanel).getByText('Cloudflare TURN 中继')).toBeInTheDocument()
    expect(within(detailsPanel).getByText('仅允许中继')).toBeInTheDocument()
    expect(within(detailsPanel).getByText('Mira（你）')).toBeInTheDocument()
    expect(within(detailsPanel).getByText('River')).toBeInTheDocument()
    expect(within(detailsPanel).queryByText(/公网 IP/u)).not.toBeInTheDocument()
  })
})

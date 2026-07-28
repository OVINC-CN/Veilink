import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentView } from '../models'
import { AttachmentPreview } from './AttachmentPreview'

function attachmentWithRecipient(recipient: NonNullable<AttachmentView['recipients']>[number]): AttachmentView {
  return {
    id: 'attachment-1',
    name: 'archive.bin',
    mime: 'application/octet-stream',
    size: 8 * 1024 * 1024,
    status: 'sending',
    progress: recipient.progress,
    previewable: false,
    recipients: [recipient],
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('attachment recipient duration', () => {
  it('updates active recipient total time once per second', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(10_000))
    render(
      <AttachmentPreview
        locale="zh-CN"
        attachment={attachmentWithRecipient({
          memberId: 'member-1',
          nickname: 'Mira',
          status: 'transferring',
          startedAt: 7_000,
          transferredBytes: 2 * 1024 * 1024,
          progress: 0.25,
          bytesPerSecond: 1024 * 1024,
          etaSeconds: 6,
          rttMs: 42,
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '接收详情' }))
    expect(screen.getByText(/总耗时 3s/u)).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(2_000))
    expect(screen.getByText(/总耗时 5s/u)).toBeInTheDocument()
  })

  it('freezes terminal duration and renders a localized structured failure reason', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(100_000))
    render(
      <AttachmentPreview
        locale="en-US"
        attachment={attachmentWithRecipient({
          memberId: 'member-2',
          nickname: 'River',
          status: 'failed',
          startedAt: 1_000,
          finishedAt: 66_000,
          failureReason: 'recipient-too-slow',
          transferredBytes: 3 * 1024 * 1024,
          progress: 0.375,
          bytesPerSecond: 0,
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delivery details' }))
    expect(screen.getByText(/Total time 1m 5s/u)).toBeInTheDocument()
    expect(screen.getByText(/Reason: Recipient too slow/u)).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByText(/Total time 1m 5s/u)).toBeInTheDocument()
  })
})

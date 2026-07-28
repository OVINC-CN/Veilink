// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'

import { FILE_ENCRYPTION_CREDIT_WINDOW, encryptFile } from './files'

type Listener = EventListenerOrEventListenerObject

class CreditWorker {
  static latest: CreditWorker | undefined

  readonly creditGrants: number[] = []
  produced = 0
  terminated = false

  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly totalChunks = 10

  constructor() {
    CreditWorker.latest = this
  }

  addEventListener(type: string, listener: Listener | null): void {
    if (!listener) return
    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: Listener | null): void {
    if (listener) this.listeners.get(type)?.delete(listener)
  }

  postMessage(message: unknown): void {
    const request = message as { type?: string; count?: number }
    if (request.type === 'encrypt-init') {
      queueMicrotask(() => this.emit('message', { type: 'ready', header: 'header' }))
      return
    }
    if (request.type === 'encrypt-credit') {
      const count = request.count ?? 0
      this.creditGrants.push(count)
      for (let credit = 0; credit < count && this.produced < this.totalChunks; credit += 1) {
        const index = this.produced
        const final = index === this.totalChunks - 1
        this.produced += 1
        this.emit('message', {
          type: 'chunk',
          index,
          final,
          ciphertext: new ArrayBuffer(17),
          ...(final ? { digest: new ArrayBuffer(32) } : {}),
        })
      }
    }
  }

  terminate(): void {
    this.terminated = true
  }

  private emit(type: string, data: unknown): void {
    const event = { data } as MessageEvent
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(event)
      else listener.handleEvent(event)
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  CreditWorker.latest = undefined
})

describe('file encryption credit stream', () => {
  it('does not prefetch beyond eight chunks while the consumer is blocked', async () => {
    vi.stubGlobal('Worker', CreditWorker)
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const received: number[] = []

    const encryption = encryptFile(
      new File([new Uint8Array(1)], 'bounded.bin'),
      'file-id',
      new Uint8Array(32),
      () => undefined,
      async (chunk) => {
        received.push(chunk.index)
        if (chunk.index === 0) {
          markFirstStarted()
          await firstGate
        }
      },
    )

    await firstStarted
    const worker = CreditWorker.latest!
    expect(worker.creditGrants).toEqual([FILE_ENCRYPTION_CREDIT_WINDOW])
    expect(worker.produced).toBe(FILE_ENCRYPTION_CREDIT_WINDOW)

    releaseFirst()
    await encryption

    expect(received).toEqual(Array.from({ length: 10 }, (_, index) => index))
    expect(worker.creditGrants[0]).toBe(8)
    expect(worker.creditGrants.slice(1).every((credit) => credit === 1)).toBe(true)
    expect(worker.terminated).toBe(true)
  })
})

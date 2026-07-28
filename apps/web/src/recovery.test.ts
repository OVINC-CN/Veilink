import { webcrypto } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from './models'
import { bytesToBase64Url } from './lib/encoding'
import {
  buildRecoveryBundle,
  buildRecoveryStateBundle,
  clearRecovery,
  hasRecoveryHint,
  loadRecovery,
  restoreIdentity,
  saveRecoveryHistory,
  saveRecoveryState,
} from './recovery'

const LEGACY_STORAGE_KEY = 'veilink.recovery.v1'
const STATE_STORAGE_KEY = 'veilink.recovery.state.v2'
const HISTORY_STORAGE_KEY = 'veilink.recovery.history.v2'
const HISTORY_KEY = '__veilinkRecoveryKey'
const NOW = 1_800_000_000_000

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (seed + index) & 0xff)
}

function encoded(length: number, seed: number): string {
  return bytesToBase64Url(bytes(length, seed))
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer
}

function message(
  senderId: string,
  senderIdentityPublicKey: string,
  messageId: string,
  text: string,
): ChatMessage {
  return {
    id: `${senderId}:${messageId}`,
    messageId,
    senderId,
    senderName: 'Mira',
    senderIdentityPublicKey,
    sentAt: NOW - 1_000,
    document: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    },
    attachments: [],
  }
}

function recoveryInput() {
  const roomId = encoded(16, 1)
  const memberId = encoded(16, 21)
  const sessionId = encoded(16, 41)
  const senderIdentityPublicKey = encoded(32, 61)
  const firstMessageId = encoded(16, 101)
  const secondMessageId = encoded(16, 121)

  return {
    roomId,
    memberId,
    resumeToken: encoded(32, 141),
    linkSecret: encoded(32, 181),
    pin: '042731',
    expiresAt: NOW + 60 * 60_000,
    identity: {
      publicKey: bytes(32, 61),
      privateKey: bytes(64, 81),
      sessionId,
      counter: 37,
    },
    keys: {
      admissionKey: bytes(32, 3),
      messageKey: bytes(32, 43),
      fileKey: bytes(32, 83),
      fingerprintKey: bytes(32, 123),
      fingerprint: 'ABCD ABCD ABCD ABCD ABCD ABCD ABCD ABCD',
    },
    replayCounters: new Map([[`${memberId}:${sessionId}`, 19]]),
    messages: [
      message(memberId, senderIdentityPublicKey, firstMessageId, 'first recovered message'),
      message(memberId, senderIdentityPublicKey, secondMessageId, 'second recovered message'),
    ],
    pendingDeliveryAcknowledgements: [{ senderId: memberId, messageId: firstMessageId }],
  }
}

async function writeLegacyEnvelope(bundle: ReturnType<typeof buildRecoveryBundle>): Promise<void> {
  const keyBytes = bytes(32, 211)
  const iv = bytes(12, 17)
  const key = await crypto.subtle.importKey(
    'raw',
    arrayBuffer(keyBytes),
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  )
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: arrayBuffer(iv),
      additionalData: arrayBuffer(new TextEncoder().encode(`veilink/recovery/v1\0${bundle.roomId}`)),
      tagLength: 128,
    },
    key,
    arrayBuffer(new TextEncoder().encode(JSON.stringify(bundle))),
  )

  window.history.replaceState({ [HISTORY_KEY]: bytesToBase64Url(keyBytes) }, '')
  sessionStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({
    v: 1,
    roomId: bundle.roomId,
    expiresAt: bundle.expiresAt,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  }))
}

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto as unknown as Crypto)
})

afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  clearRecovery()
  sessionStorage.clear()
  window.history.replaceState({}, '')
})

describe('split recovery checkpoints', () => {
  it('saves critical state and disposable history independently, then merges them on load', async () => {
    const input = recoveryInput()
    const state = buildRecoveryStateBundle(input, 512)
    const history = buildRecoveryBundle(input)

    await expect(saveRecoveryState(state)).resolves.toBe(true)
    await expect(saveRecoveryHistory(history)).resolves.toBe(true)

    expect(sessionStorage.getItem(STATE_STORAGE_KEY)).not.toBeNull()
    expect(sessionStorage.getItem(HISTORY_STORAGE_KEY)).not.toBeNull()

    const recovered = await loadRecovery(input.roomId)
    expect(recovered?.identity.counter).toBe(512)
    expect(recovered?.messages.map((item) => item.document)).toEqual(
      history.messages.map((item) => item.document),
    )
    expect(recovered?.pendingDeliveryAcknowledgements).toEqual(
      state.pendingDeliveryAcknowledgements,
    )

    sessionStorage.removeItem(HISTORY_STORAGE_KEY)
    await expect(loadRecovery(input.roomId)).resolves.toMatchObject({
      identity: { counter: 512 },
      messages: [],
    })
  })

  it('restores from the reserved counter ceiling so the next counter skips unused values', async () => {
    const input = recoveryInput()
    const counterCeiling = input.identity.counter + 256

    await expect(
      saveRecoveryState(buildRecoveryStateBundle(input, counterCeiling)),
    ).resolves.toBe(true)

    const recovered = await loadRecovery(input.roomId)
    expect(recovered).toBeDefined()
    expect(restoreIdentity(recovered!).counter).toBe(counterCeiling)
    expect(restoreIdentity(recovered!).counter + 1).toBe(294)
  })

  it('preserves the critical checkpoint when the optional history write fails', async () => {
    const input = recoveryInput()
    const state = buildRecoveryStateBundle(input, 768)

    await expect(saveRecoveryState(state)).resolves.toBe(true)
    const storedState = sessionStorage.getItem(STATE_STORAGE_KEY)
    const nativeSetItem = Storage.prototype.setItem
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (this === sessionStorage && key === HISTORY_STORAGE_KEY) {
        throw new DOMException('Quota exceeded', 'QuotaExceededError')
      }
      nativeSetItem.call(this, key, value)
    })

    await expect(saveRecoveryHistory(buildRecoveryBundle(input))).resolves.toBe(false)
    setItem.mockRestore()

    expect(sessionStorage.getItem(STATE_STORAGE_KEY)).toBe(storedState)
    expect(sessionStorage.getItem(HISTORY_STORAGE_KEY)).toBeNull()
    await expect(loadRecovery(input.roomId)).resolves.toMatchObject({
      identity: { counter: 768 },
      messages: [],
    })
  })

  it('reads a legacy v1 record and removes it after writing the new state checkpoint', async () => {
    const input = recoveryInput()
    const legacy = buildRecoveryBundle(input)
    await writeLegacyEnvelope(legacy)

    expect(hasRecoveryHint(input.roomId)).toBe(true)
    await expect(loadRecovery(input.roomId)).resolves.toMatchObject({
      roomId: input.roomId,
      identity: { counter: input.identity.counter },
      messages: legacy.messages,
    })

    await expect(
      saveRecoveryState(buildRecoveryStateBundle(input, 256)),
    ).resolves.toBe(true)

    expect(sessionStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull()
    expect(sessionStorage.getItem(STATE_STORAGE_KEY)).not.toBeNull()
    await expect(loadRecovery(input.roomId)).resolves.toMatchObject({
      identity: { counter: 256 },
      messages: [],
    })
  })
})

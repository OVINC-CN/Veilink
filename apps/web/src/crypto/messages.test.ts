// @vitest-environment node

import type { IdentityPublicKey } from '../protocol'
import sodium from 'libsodium-wrappers-sumo'
import { beforeAll, describe, expect, it } from 'vitest'
import { bytesToBase64Url } from '../lib/encoding'
import {
  acceptReplayCounter,
  createSessionIdentity,
  decryptChatPayload,
  destroyIdentity,
  encryptChatPayload,
} from './messages'

describe('encrypted chat frames', () => {
  beforeAll(async () => {
    await sodium.ready
  })

  it('signs, encrypts and decrypts a payload while incrementing counters', async () => {
    const identity = await createSessionIdentity()
    const messageKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
    const publicKey = bytesToBase64Url(identity.publicKey) as IdentityPublicKey

    try {
      const first = await encryptChatPayload({ type: 'rich-text', text: 'private' }, 'member-a', identity, messageKey)
      const second = await encryptChatPayload({ type: 'rich-text', text: 'next' }, 'member-a', identity, messageKey)

      await expect(decryptChatPayload(first, messageKey, publicKey)).resolves.toEqual({
        type: 'rich-text',
        text: 'private',
      })
      expect(first.counter).toBe(1)
      expect(second.counter).toBe(2)
      expect(first.ciphertext).not.toContain('private')
    } finally {
      destroyIdentity(identity)
      sodium.memzero(messageKey)
    }
  })

  it('rejects a changed ciphertext or signature', async () => {
    const identity = await createSessionIdentity()
    const messageKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
    const publicKey = bytesToBase64Url(identity.publicKey) as IdentityPublicKey

    try {
      const frame = await encryptChatPayload({ secret: 'value' }, 'member-a', identity, messageKey)
      const ciphertext = `${frame.ciphertext.startsWith('A') ? 'B' : 'A'}${frame.ciphertext.slice(1)}`
      const signature = `${frame.signature.startsWith('A') ? 'B' : 'A'}${frame.signature.slice(1)}`

      await expect(decryptChatPayload({ ...frame, ciphertext }, messageKey, publicKey)).rejects.toThrow()
      await expect(decryptChatPayload({ ...frame, signature: signature as typeof frame.signature }, messageKey, publicKey)).rejects.toThrow('Message signature is invalid')
    } finally {
      destroyIdentity(identity)
      sodium.memzero(messageKey)
    }
  })
})

describe('replay counter acceptance', () => {
  it('accepts only strict monotonic counters per sender session without mutating input', () => {
    const empty = new Map<string, number>()
    const first = acceptReplayCounter(empty, 'member-a', 'session-a', 1)

    expect(first?.get('member-a:session-a')).toBe(1)
    expect(empty.size).toBe(0)
    expect(acceptReplayCounter(first ?? empty, 'member-a', 'session-a', 1)).toBeUndefined()
    expect(acceptReplayCounter(first ?? empty, 'member-a', 'session-a', 0)).toBeUndefined()
    expect(acceptReplayCounter(first ?? empty, 'member-a', 'session-a', Number.NaN)).toBeUndefined()

    const next = acceptReplayCounter(first ?? empty, 'member-a', 'session-a', 3)
    expect(next?.get('member-a:session-a')).toBe(3)
    expect(acceptReplayCounter(next ?? empty, 'member-b', 'session-a', 1)?.get('member-b:session-a')).toBe(1)
    expect(acceptReplayCounter(next ?? empty, 'member-a', 'session-b', 1)?.get('member-a:session-b')).toBe(1)
  })
})

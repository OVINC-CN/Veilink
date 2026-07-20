import sodium from 'libsodium-wrappers-sumo'
import type { EncryptedChatFrame, IdentityPublicKey } from '@veilink/protocol'
import { base64UrlToBytes, bytesToBase64Url, concatBytes, randomId } from '../lib/encoding'
import type { SessionIdentity } from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder(undefined, { fatal: true })

export function acceptReplayCounter(
  counters: ReadonlyMap<string, number>,
  senderId: string,
  sessionId: string,
  counter: number,
): Map<string, number> | undefined {
  if (!Number.isSafeInteger(counter) || counter <= 0) return undefined
  const key = `${senderId}:${sessionId}`
  if (counter <= (counters.get(key) ?? 0)) return undefined
  const next = new Map(counters)
  next.set(key, counter)
  return next
}

function signingBytes(envelope: Omit<EncryptedChatFrame, 'signature'>): Uint8Array {
  return concatBytes(
    encoder.encode(`${envelope.v}|${envelope.type}|${envelope.messageId}|${envelope.senderId}|${envelope.sessionId}|${envelope.counter}|${envelope.sentAt}|${envelope.algorithm}|`),
    base64UrlToBytes(envelope.nonce),
    base64UrlToBytes(envelope.ciphertext),
  )
}

function additionalData(messageId: string, senderId: string, sessionId: string, counter: number, sentAt: number): Uint8Array {
  return encoder.encode(`veilink/v1/chat|${messageId}|${senderId}|${sessionId}|${counter}|${sentAt}`)
}

export async function createSessionIdentity(): Promise<SessionIdentity> {
  await sodium.ready
  const keyPair = sodium.crypto_sign_keypair()
  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    sessionId: randomId(16),
    counter: 0,
  }
}

export async function encryptChatPayload(
  payload: unknown,
  senderId: string,
  identity: SessionIdentity,
  messageKey: Uint8Array,
): Promise<EncryptedChatFrame> {
  await sodium.ready
  identity.counter += 1
  const sentAt = Date.now()
  const messageId = randomId(16)
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const plaintext = encoder.encode(JSON.stringify(payload))
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    additionalData(messageId, senderId, identity.sessionId, identity.counter, sentAt),
    null,
    nonce,
    messageKey,
  )
  const unsigned: Omit<EncryptedChatFrame, 'signature'> = {
    v: 1,
    type: 'chat',
    messageId: messageId as never,
    senderId: senderId as never,
    sessionId: identity.sessionId as never,
    counter: identity.counter,
    sentAt,
    algorithm: 'XChaCha20-Poly1305-IETF',
    nonce: bytesToBase64Url(nonce) as never,
    ciphertext: bytesToBase64Url(ciphertext),
  }
  const signature = sodium.crypto_sign_detached(signingBytes(unsigned), identity.privateKey)
  sodium.memzero(plaintext)
  return { ...unsigned, signature: bytesToBase64Url(signature) as never }
}

export async function decryptChatPayload<T>(
  envelope: EncryptedChatFrame,
  messageKey: Uint8Array,
  identityPublicKey: IdentityPublicKey,
): Promise<T> {
  await sodium.ready
  const { signature, ...unsigned } = envelope
  const publicKey = base64UrlToBytes(identityPublicKey)
  const verified = sodium.crypto_sign_verify_detached(
    base64UrlToBytes(signature),
    signingBytes(unsigned),
    publicKey,
  )
  if (!verified) throw new Error('Message signature is invalid')

  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    base64UrlToBytes(envelope.ciphertext),
    additionalData(envelope.messageId, envelope.senderId, envelope.sessionId, envelope.counter, envelope.sentAt),
    base64UrlToBytes(envelope.nonce),
    messageKey,
  )
  try {
    return JSON.parse(decoder.decode(plaintext)) as T
  } finally {
    sodium.memzero(plaintext)
  }
}

export function destroyIdentity(identity: SessionIdentity): void {
  sodium.memzero(identity.privateKey)
  sodium.memzero(identity.publicKey)
  identity.counter = Number.MAX_SAFE_INTEGER
}

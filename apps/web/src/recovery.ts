import {
  IdentityPublicKeySchema,
  LinkSecretSchema,
  MemberIdSchema,
  MessageIdSchema,
  NicknameSchema,
  PinSchema,
  ReplyReferenceSchema,
  RichTextDocumentSchema,
  ResumeTokenSchema,
  RoomIdSchema,
  SessionIdSchema,
} from '@veilink/protocol'
import type { ChatMessage } from './models'
import type { DerivedKeys, SessionIdentity } from './crypto/types'
import { base64UrlToBytes, bytesToBase64Url, randomBytes } from './lib/encoding'

const STORAGE_KEY = 'veilink.recovery.v1'
const HISTORY_KEY = '__veilinkRecoveryKey'
const MAX_ENVELOPE_BYTES = 1_500_000
const MAX_PLAINTEXT_BYTES = 1_000_000
const MAX_RECOVERED_MESSAGES = 100
const MAX_RECOVERED_MESSAGE_BYTES = 700_000
const encoder = new TextEncoder()
const decoder = new TextDecoder(undefined, { fatal: true })

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

interface StoredEnvelope {
  v: 1
  roomId: string
  expiresAt: number
  iv: string
  ciphertext: string
}

interface SerializedIdentity {
  publicKey: string
  privateKey: string
  sessionId: string
  counter: number
}

interface SerializedKeys {
  admissionKey: string
  messageKey: string
  fileKey: string
  fingerprintKey: string
  fingerprint: string
}

interface SerializedReplayCounter {
  senderId: string
  sessionId: string
  counter: number
}

export interface RecoveryBundle {
  v: 1
  roomId: string
  memberId: string
  resumeToken: string
  linkSecret: string
  pin?: string
  expiresAt: number
  savedAt: number
  identity: SerializedIdentity
  keys: SerializedKeys
  replayCounters: SerializedReplayCounter[]
  messages: ChatMessage[]
}

let writeChain = Promise.resolve()
let recoveryGeneration = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function exactBytes(value: unknown, byteLength: number): value is string {
  if (typeof value !== 'string') return false
  try {
    return base64UrlToBytes(value).byteLength === byteLength
  } catch {
    return false
  }
}

function historyRecoveryKey(): Uint8Array | undefined {
  const state: unknown = window.history.state
  if (!isRecord(state) || !exactBytes(state[HISTORY_KEY], 32)) return undefined
  return base64UrlToBytes(state[HISTORY_KEY])
}

function ensureHistoryRecoveryKey(): Uint8Array {
  const existing = historyRecoveryKey()
  if (existing) return existing
  const key = randomBytes(32)
  const current = isRecord(window.history.state) ? window.history.state : {}
  window.history.replaceState({ ...current, [HISTORY_KEY]: bytesToBase64Url(key) }, '')
  return key
}

function aad(roomId: string): Uint8Array {
  return encoder.encode(`veilink/recovery/v1\0${roomId}`)
}

function purgeRecoveryArtifacts(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage can be unavailable; server-side resume leases still expire.
  }
  try {
    const current = isRecord(window.history.state) ? { ...window.history.state } : {}
    delete current[HISTORY_KEY]
    window.history.replaceState(current, '')
  } catch {
    // History state can be unavailable in restricted browsing contexts.
  }
}

async function importKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  const copy = new Uint8Array(keyBytes)
  return await crypto.subtle.importKey('raw', copy, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

function parseEnvelope(raw: string): StoredEnvelope | undefined {
  if (raw.length === 0 || raw.length > MAX_ENVELOPE_BYTES) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    !RoomIdSchema.safeParse(value.roomId).success ||
    typeof value.expiresAt !== 'number' ||
    !Number.isSafeInteger(value.expiresAt) ||
    !exactBytes(value.iv, 12) ||
    typeof value.ciphertext !== 'string' ||
    value.ciphertext.length > MAX_ENVELOPE_BYTES
  ) return undefined
  return value as unknown as StoredEnvelope
}

function parseBundle(value: unknown): RecoveryBundle | undefined {
  if (!isRecord(value) || value.v !== 1 || !exactKeys(value, ['v', 'roomId', 'memberId', 'resumeToken', 'linkSecret', ...(value.pin === undefined ? [] : ['pin']), 'expiresAt', 'savedAt', 'identity', 'keys', 'replayCounters', 'messages'])) return undefined
  const identity = value.identity
  const keys = value.keys
  if (
    !RoomIdSchema.safeParse(value.roomId).success ||
    !MemberIdSchema.safeParse(value.memberId).success ||
    !ResumeTokenSchema.safeParse(value.resumeToken).success ||
    !LinkSecretSchema.safeParse(value.linkSecret).success ||
    (value.pin !== undefined && !PinSchema.safeParse(value.pin).success) ||
    typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) ||
    typeof value.savedAt !== 'number' || !Number.isSafeInteger(value.savedAt) ||
    !isRecord(identity) ||
    !exactKeys(identity, ['publicKey', 'privateKey', 'sessionId', 'counter']) ||
    !IdentityPublicKeySchema.safeParse(identity.publicKey).success ||
    !exactBytes(identity.privateKey, 64) ||
    !SessionIdSchema.safeParse(identity.sessionId).success ||
    typeof identity.counter !== 'number' || !Number.isSafeInteger(identity.counter) || identity.counter < 0 ||
    !isRecord(keys) ||
    !exactKeys(keys, ['admissionKey', 'messageKey', 'fileKey', 'fingerprintKey', 'fingerprint']) ||
    !exactBytes(keys.admissionKey, 32) ||
    !exactBytes(keys.messageKey, 32) ||
    !exactBytes(keys.fileKey, 32) ||
    !exactBytes(keys.fingerprintKey, 32) ||
    typeof keys.fingerprint !== 'string' || !/^(?:[A-F0-9]{4} ){7}[A-F0-9]{4}$/u.test(keys.fingerprint) ||
    !Array.isArray(value.replayCounters) || value.replayCounters.length > 32 || !parseReplayCounters(value.replayCounters) ||
    !Array.isArray(value.messages) || value.messages.length > MAX_RECOVERED_MESSAGES
  ) return undefined
  const messages = parseMessages(value.messages)
  if (!messages) return undefined
  return { ...(value as unknown as RecoveryBundle), messages }
}

function parseReplayCounters(value: unknown[]): Map<string, number> | undefined {
  const counters = new Map<string, number>()
  for (const item of value) {
    if (!isRecord(item) || !exactKeys(item, ['senderId', 'sessionId', 'counter'])) return undefined
    const senderId = MemberIdSchema.safeParse(item.senderId)
    const sessionId = SessionIdSchema.safeParse(item.sessionId)
    if (!senderId.success || !sessionId.success || typeof item.counter !== 'number' || !Number.isSafeInteger(item.counter) || item.counter <= 0) return undefined
    const key = `${senderId.data}:${sessionId.data}`
    if (counters.has(key)) return undefined
    counters.set(key, item.counter)
  }
  return counters
}

function parseMessages(value: unknown[]): ChatMessage[] | undefined {
  const messages: ChatMessage[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isRecord(item) || !exactKeys(item, ['id', 'messageId', 'senderId', 'senderName', 'senderIdentityPublicKey', 'sentAt', 'document', 'attachments', ...(item.replyTo === undefined ? [] : ['replyTo'])])) return undefined
    const messageId = MessageIdSchema.safeParse(item.messageId)
    const senderId = MemberIdSchema.safeParse(item.senderId)
    const senderName = NicknameSchema.safeParse(item.senderName)
    const senderKey = IdentityPublicKeySchema.safeParse(item.senderIdentityPublicKey)
    const document = RichTextDocumentSchema.safeParse(item.document)
    const replyTo = item.replyTo === undefined ? undefined : ReplyReferenceSchema.safeParse(item.replyTo)
    if (
      !messageId.success || !senderId.success || !senderName.success || !senderKey.success || !document.success ||
      (replyTo !== undefined && !replyTo.success) ||
      item.id !== `${senderId.data}:${messageId.data}` ||
      typeof item.sentAt !== 'number' || !Number.isSafeInteger(item.sentAt) || item.sentAt < 0 ||
      !Array.isArray(item.attachments) || item.attachments.length !== 0
    ) return undefined
    if (seen.has(item.id)) return undefined
    seen.add(item.id)
    messages.push({
      id: item.id,
      messageId: messageId.data,
      senderId: senderId.data,
      senderName: senderName.data,
      senderIdentityPublicKey: senderKey.data,
      sentAt: item.sentAt,
      document: document.data,
      attachments: [],
      ...(replyTo?.success ? { replyTo: replyTo.data } : {}),
    })
  }
  return messages
}

function recoverableMessages(messages: ChatMessage[]): ChatMessage[] {
  const candidates = messages
    .filter((message) => message.attachments.length === 0)
    .slice(-MAX_RECOVERED_MESSAGES)
    .map((message) => ({ ...message, attachments: [] }))
  const recovered: ChatMessage[] = []
  let bytes = 2
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index]!
    const messageBytes = encoder.encode(JSON.stringify(message)).byteLength + 1
    if (bytes + messageBytes > MAX_RECOVERED_MESSAGE_BYTES) break
    recovered.unshift(message)
    bytes += messageBytes
  }
  return recovered
}

export function hasRecoveryHint(roomId?: string): boolean {
  if (!roomId || !historyRecoveryKey()) return false
  try {
    const envelope = parseEnvelope(sessionStorage.getItem(STORAGE_KEY) ?? '')
    return envelope?.roomId === roomId && envelope.expiresAt > Date.now()
  } catch {
    return false
  }
}

export function buildRecoveryBundle(input: {
  roomId: string
  memberId: string
  resumeToken: string
  linkSecret: string
  pin?: string
  expiresAt: number
  identity: SessionIdentity
  keys: DerivedKeys
  replayCounters: ReadonlyMap<string, number>
  messages: ChatMessage[]
}): RecoveryBundle {
  return {
    v: 1,
    roomId: input.roomId,
    memberId: input.memberId,
    resumeToken: input.resumeToken,
    linkSecret: input.linkSecret,
    ...(input.pin ? { pin: input.pin } : {}),
    expiresAt: input.expiresAt,
    savedAt: Date.now(),
    identity: {
      publicKey: bytesToBase64Url(input.identity.publicKey),
      privateKey: bytesToBase64Url(input.identity.privateKey),
      sessionId: input.identity.sessionId,
      counter: input.identity.counter,
    },
    keys: {
      admissionKey: bytesToBase64Url(input.keys.admissionKey),
      messageKey: bytesToBase64Url(input.keys.messageKey),
      fileKey: bytesToBase64Url(input.keys.fileKey),
      fingerprintKey: bytesToBase64Url(input.keys.fingerprintKey),
      fingerprint: input.keys.fingerprint,
    },
    replayCounters: [...input.replayCounters.entries()].slice(-32).map(([key, counter]) => {
      const separator = key.indexOf(':')
      return { senderId: key.slice(0, separator), sessionId: key.slice(separator + 1), counter }
    }),
    messages: recoverableMessages(input.messages),
  }
}

export function restoreIdentity(bundle: RecoveryBundle): SessionIdentity {
  return {
    publicKey: base64UrlToBytes(bundle.identity.publicKey),
    privateKey: base64UrlToBytes(bundle.identity.privateKey),
    sessionId: bundle.identity.sessionId,
    counter: bundle.identity.counter,
  }
}

export function restoreKeys(bundle: RecoveryBundle): DerivedKeys {
  return {
    admissionKey: base64UrlToBytes(bundle.keys.admissionKey),
    messageKey: base64UrlToBytes(bundle.keys.messageKey),
    fileKey: base64UrlToBytes(bundle.keys.fileKey),
    fingerprintKey: base64UrlToBytes(bundle.keys.fingerprintKey),
    fingerprint: bundle.keys.fingerprint,
  }
}

export function restoreReplayCounters(bundle: RecoveryBundle): Map<string, number> {
  return parseReplayCounters(bundle.replayCounters) ?? new Map()
}

export function saveRecovery(bundle: RecoveryBundle): Promise<boolean> {
  const generation = recoveryGeneration
  let saved = false
  writeChain = writeChain.then(async () => {
    if (generation !== recoveryGeneration || bundle.expiresAt <= Date.now()) return
    const plaintext = encoder.encode(JSON.stringify(bundle))
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
      plaintext.fill(0)
      purgeRecoveryArtifacts()
      return
    }
    let keyBytes: Uint8Array | undefined
    try {
      keyBytes = ensureHistoryRecoveryKey()
      const key = await importKey(keyBytes)
      const iv = randomBytes(12)
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad(bundle.roomId)), tagLength: 128 }, key, toArrayBuffer(plaintext))
      const envelope: StoredEnvelope = {
        v: 1,
        roomId: bundle.roomId,
        expiresAt: bundle.expiresAt,
        iv: bytesToBase64Url(iv),
        ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
      }
      const serialized = JSON.stringify(envelope)
      if (generation === recoveryGeneration && serialized.length <= MAX_ENVELOPE_BYTES) {
        sessionStorage.setItem(STORAGE_KEY, serialized)
        saved = true
      }
    } finally {
      plaintext.fill(0)
      keyBytes?.fill(0)
    }
  }).catch(() => purgeRecoveryArtifacts())
  return writeChain.then(() => saved)
}

export async function loadRecovery(expectedRoomId: string): Promise<RecoveryBundle | undefined> {
  const keyBytes = historyRecoveryKey()
  if (!keyBytes) return undefined
  try {
    const envelope = parseEnvelope(sessionStorage.getItem(STORAGE_KEY) ?? '')
    if (!envelope || envelope.roomId !== expectedRoomId || envelope.expiresAt <= Date.now()) return undefined
    const key = await importKey(keyBytes)
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(base64UrlToBytes(envelope.iv)), additionalData: toArrayBuffer(aad(envelope.roomId)), tagLength: 128 }, key, toArrayBuffer(base64UrlToBytes(envelope.ciphertext)))
    const plaintext = new Uint8Array(decrypted)
    try {
      const bundle = parseBundle(JSON.parse(decoder.decode(plaintext)) as unknown)
      const now = Date.now()
      if (!bundle || bundle.roomId !== expectedRoomId || bundle.expiresAt !== envelope.expiresAt || bundle.expiresAt <= now || bundle.savedAt > now + 5 * 60_000) return undefined
      return bundle
    } finally {
      plaintext.fill(0)
    }
  } catch {
    return undefined
  } finally {
    keyBytes.fill(0)
  }
}

export function clearRecovery(): void {
  recoveryGeneration += 1
  purgeRecoveryArtifacts()
}

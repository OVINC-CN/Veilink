import { LinkSecretSchema, MAX_ROOM_TTL_MS, RoomIdSchema } from './protocol'
import { base64UrlToBytes, bytesToBase64Url, randomBytes } from './lib/encoding'

const STORAGE_KEY = 'veilink.invitation.v1'
const HISTORY_KEY = '__veilinkInvitationKey'
const BOOTSTRAP_HISTORY_KEY = '__veilinkBootstrapInvite'
const MAX_ENVELOPE_BYTES = 1_024
const encoder = new TextEncoder()
const decoder = new TextDecoder(undefined, { fatal: true })

interface StoredInvitationEnvelope {
  v: 1
  roomId: string
  expiresAt: number
  iv: string
  ciphertext: string
}

interface StoredInvitation {
  v: 1
  roomId: string
  linkSecret: string
  savedAt: number
}

let writeChain = Promise.resolve()
let generation = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactBytes(value: unknown, byteLength: number): value is string {
  if (typeof value !== 'string') return false
  try {
    return base64UrlToBytes(value).byteLength === byteLength
  } catch {
    return false
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function historyKey(): Uint8Array | undefined {
  const state: unknown = window.history.state
  if (!isRecord(state) || !exactBytes(state[HISTORY_KEY], 32)) return undefined
  return base64UrlToBytes(state[HISTORY_KEY])
}

function ensureHistoryKey(): Uint8Array {
  const existing = historyKey()
  if (existing) return existing
  const key = randomBytes(32)
  const current = isRecord(window.history.state) ? window.history.state : {}
  window.history.replaceState({ ...current, [HISTORY_KEY]: bytesToBase64Url(key) }, '')
  return key
}

function removeBootstrapFallback(): void {
  try {
    const current = isRecord(window.history.state) ? { ...window.history.state } : {}
    delete current[BOOTSTRAP_HISTORY_KEY]
    window.history.replaceState(current, '')
  } catch {
    // The fragment bootstrap fallback remains scoped to this history entry.
  }
}

function purgeInvitationArtifacts(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage can be unavailable in restricted browsing contexts.
  }
  try {
    const current = isRecord(window.history.state) ? { ...window.history.state } : {}
    delete current[HISTORY_KEY]
    delete current[BOOTSTRAP_HISTORY_KEY]
    window.history.replaceState(current, '')
  } catch {
    // History state can be unavailable in restricted browsing contexts.
  }
}

function parseEnvelope(raw: string): StoredInvitationEnvelope | undefined {
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
  return value as unknown as StoredInvitationEnvelope
}

function parseInvitation(value: unknown): StoredInvitation | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 4 || value.v !== 1) return undefined
  if (
    !RoomIdSchema.safeParse(value.roomId).success ||
    !LinkSecretSchema.safeParse(value.linkSecret).success ||
    typeof value.savedAt !== 'number' ||
    !Number.isSafeInteger(value.savedAt)
  ) return undefined
  return value as unknown as StoredInvitation
}

function aad(roomId: string): Uint8Array {
  return encoder.encode(`veilink/invitation/v1\0${roomId}`)
}

async function importKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  const copy = new Uint8Array(keyBytes)
  try {
    return await crypto.subtle.importKey('raw', copy, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  } finally {
    copy.fill(0)
  }
}

export function hasInvitationRecoveryHint(roomId?: string): boolean {
  if (!roomId) return false
  const keyBytes = historyKey()
  if (!keyBytes) return false
  try {
    const envelope = parseEnvelope(sessionStorage.getItem(STORAGE_KEY) ?? '')
    return envelope?.roomId === roomId && envelope.expiresAt > Date.now()
  } catch {
    return false
  } finally {
    keyBytes.fill(0)
  }
}

export function saveInvitationSecret(rawRoomId: string, rawLinkSecret: string): Promise<boolean> {
  const roomId = RoomIdSchema.parse(rawRoomId)
  const linkSecret = LinkSecretSchema.parse(rawLinkSecret)
  const writeGeneration = generation
  const task = writeChain.then(async (): Promise<boolean> => {
    if (writeGeneration !== generation) return false
    const savedAt = Date.now()
    const expiresAt = savedAt + MAX_ROOM_TTL_MS
    const plaintext = encoder.encode(JSON.stringify({ v: 1, roomId, linkSecret, savedAt } satisfies StoredInvitation))
    let keyBytes: Uint8Array | undefined
    let iv: Uint8Array | undefined
    try {
      keyBytes = ensureHistoryKey()
      const key = await importKey(keyBytes)
      iv = randomBytes(12)
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad(roomId)), tagLength: 128 },
        key,
        toArrayBuffer(plaintext),
      )
      if (writeGeneration !== generation) return false
      const serialized = JSON.stringify({
        v: 1,
        roomId,
        expiresAt,
        iv: bytesToBase64Url(iv),
        ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
      } satisfies StoredInvitationEnvelope)
      if (serialized.length > MAX_ENVELOPE_BYTES) return false
      sessionStorage.setItem(STORAGE_KEY, serialized)
      removeBootstrapFallback()
      return true
    } finally {
      plaintext.fill(0)
      keyBytes?.fill(0)
      iv?.fill(0)
    }
  }).catch(() => false)
  writeChain = task.then(() => undefined)
  return task
}

export async function loadInvitationSecret(expectedRoomId: string): Promise<string | undefined> {
  const roomId = RoomIdSchema.parse(expectedRoomId)
  const keyBytes = historyKey()
  if (!keyBytes) return undefined
  try {
    const envelope = parseEnvelope(sessionStorage.getItem(STORAGE_KEY) ?? '')
    const now = Date.now()
    if (!envelope || envelope.roomId !== roomId || envelope.expiresAt <= now) return undefined
    const key = await importKey(keyBytes)
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(base64UrlToBytes(envelope.iv)),
        additionalData: toArrayBuffer(aad(roomId)),
        tagLength: 128,
      },
      key,
      toArrayBuffer(base64UrlToBytes(envelope.ciphertext)),
    )
    const plaintext = new Uint8Array(decrypted)
    try {
      const invitation = parseInvitation(JSON.parse(decoder.decode(plaintext)) as unknown)
      if (
        !invitation ||
        invitation.roomId !== roomId ||
        invitation.savedAt > now + 5 * 60_000 ||
        now - invitation.savedAt > MAX_ROOM_TTL_MS
      ) return undefined
      return invitation.linkSecret
    } finally {
      plaintext.fill(0)
    }
  } catch {
    return undefined
  } finally {
    keyBytes.fill(0)
  }
}

export function clearInvitationRecovery(): void {
  generation += 1
  purgeInvitationArtifacts()
}

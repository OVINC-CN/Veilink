import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AttachmentMetadataSchema,
  ChatPayloadSchema,
  EncryptedChatFrameSchema,
  EncryptedFileChunkSchema,
  IdentityPublicKeySchema,
  NicknameSchema,
  PEER_CONNECTION_TIMEOUT_MS,
  PROTOCOL_VERSION,
  RoomIdSchema,
  buildInvitePath,
  generateLinkSecret,
  generatePin,
  generateRoomId,
  normalizeFileName,
  type AttachmentMetadata,
  type ChatPayload,
  type EncryptedFileChunk,
  type PublicMember,
  type RoomSnapshot,
  type ServerSignalEnvelope,
  type TurnCredentials,
} from '@veilink/protocol'
import { CreateRoomView } from './components/CreateRoomView'
import { EntryShell } from './components/EntryShell'
import { JoinRoomView } from './components/JoinRoomView'
import { RoomCreatedView } from './components/RoomCreatedView'
import { RoomShell } from './components/RoomShell'
import { deriveRoomKeys } from './crypto/derive'
import { FileDecryptor, encryptFile, hashFile, type EncryptedFileChunk as LocalEncryptedFileChunk } from './crypto/files'
import {
  acceptReplayCounter,
  createSessionIdentity,
  decryptChatPayload,
  destroyIdentity,
  encryptChatPayload,
} from './crypto/messages'
import type { DerivedKeys, SessionIdentity } from './crypto/types'
import { usePreferences } from './hooks/usePreferences'
import { bytesToBase64Url, randomId } from './lib/encoding'
import type { ActiveRoom, AttachmentView, ChatMessage, Member, RichTextDocument } from './models'
import { validateMedia } from './mediaValidation'
import { PeerMesh, type IceCredentials, type PeerSignalPayload } from './transport/PeerMesh'
import { SignalClient, type SessionConfirmation } from './transport/SignalClient'

interface PublicConfig {
  protocolVersion: typeof PROTOCOL_VERSION
  limits: { maxMembers: number; maxRoomTtlMs: number; roomTtlMs: number; maxFileSizeMb: number }
  heartbeatIntervalMs: number
  disconnectGraceMs: number
}

type Stage = 'create' | 'join' | 'created' | 'room'

const MAX_DATA_FRAME_BYTES = 128 * 1024
const MAX_MESSAGES_IN_MEMORY = 500
const MAX_REPLAY_SESSIONS_PER_PEER = 4
const MAX_SEEN_ATTACHMENTS_PER_PEER = 64
const MAX_CONCURRENT_INCOMING_FILES = 4
const MAX_RETAINED_ATTACHMENT_BYTES = 512 * 1024 * 1024
const MAX_PEER_FRAMES_PER_SECOND = 256
const MAX_PEER_BYTES_PER_SECOND = 16 * 1024 * 1024
const MAX_PEER_FRAME_VIOLATIONS = 3
const PEER_FRAME_VIOLATION_WINDOW_MS = 10_000
const INCOMING_TRANSFER_IDLE_TIMEOUT_MS = 2 * 60_000

interface PeerRateWindow {
  startedAt: number
  frames: number
  bytes: number
}

interface PeerViolationWindow {
  startedAt: number
  violations: number
}

interface SessionRuntime {
  signal: SignalClient
  identity: SessionIdentity
  mesh: PeerMesh
  keys: DerivedKeys
  linkSecret: string
  replayCounters: Map<string, number>
  peerRateWindows: Map<string, PeerRateWindow>
  peerViolationWindows: Map<string, PeerViolationWindow>
  peerDataQueues: Map<string, Promise<void>>
  peerConnectionTimers: Map<string, number>
  initialPeerIds: Set<string>
  initialConnectionComplete: boolean
  decryptors: Map<string, FileDecryptor>
  attachmentMetadata: Map<string, AttachmentMetadata>
  attachmentReservations: Map<string, number>
  incomingTransferTimers: Map<string, number>
  incomingTransfers: Set<string>
  retainedAttachmentBytes: number
  seenAttachments: Set<string>
  outboundTransfers: Map<string, AbortController>
  transferEpoch: number
  unsubscribe: () => void
  turnRefreshTimer?: number
}

interface PendingJoin {
  nickname: ReturnType<typeof NicknameSchema.parse>
  identity: SessionIdentity
  signal: SignalClient
  keys: DerivedKeys
  challenge: Awaited<ReturnType<SignalClient['beginJoin']>>
}

function routeRoomId(): string | undefined {
  const match = /^\/room\/([A-Za-z0-9_-]{22})\/?$/u.exec(window.location.pathname)
  if (!match?.[1]) return undefined
  const parsed = RoomIdSchema.safeParse(match[1])
  return parsed.success ? parsed.data : undefined
}

function memberFromWire(member: PublicMember): Member {
  return {
    id: member.memberId,
    nickname: member.nickname,
    identityPublicKey: member.identityPublicKey,
    joinedAt: member.joinedAt,
    isOwner: member.isOwner,
  }
}

function activeRoomFromSnapshot(
  snapshot: RoomSnapshot,
  selfMemberId: string,
  keys: DerivedKeys,
  linkSecret: string,
): ActiveRoom {
  const expiresAt = Date.now() + Math.max(0, snapshot.expiresAt - snapshot.serverNow)
  return {
    roomId: snapshot.roomId,
    memberId: selfMemberId,
    ownerId: snapshot.ownerId,
    expiresAt,
    linkSecret,
    fingerprint: keys.fingerprint,
    keys,
    members: snapshot.members.map(memberFromWire),
  }
}

async function loadPublicConfig(): Promise<PublicConfig> {
  const response = await fetch('/api/config', { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error('无法读取服务器配置')
  const value = await response.json() as PublicConfig
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('服务器协议版本不受支持')
  }
  return value
}

function attachmentDocument(fileName: string): RichTextDocument {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: fileName }] }] }
}

function previewKind(mime: string, previewable: boolean): AttachmentMetadata['previewKind'] {
  if (!previewable) return 'download'
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (mime === 'application/pdf') return 'pdf'
  return 'download'
}

function turnIce(credentials: TurnCredentials): IceCredentials {
  return { urls: credentials.urls, username: credentials.username, credential: credentials.credential }
}

function wipeKeys(keys: DerivedKeys): void {
  keys.admissionKey.fill(0)
  keys.messageKey.fill(0)
  keys.fileKey.fill(0)
  keys.fingerprintKey.fill(0)
}

function disposePendingJoin(pending: PendingJoin): void {
  pending.signal.close()
  destroyIdentity(pending.identity)
  wipeKeys(pending.keys)
}

function releaseAttachment(runtime: SessionRuntime, viewId: string): void {
  const timer = runtime.incomingTransferTimers.get(viewId)
  if (timer !== undefined) window.clearTimeout(timer)
  runtime.incomingTransferTimers.delete(viewId)
  const decryptor = runtime.decryptors.get(viewId)
  decryptor?.destroy()
  runtime.decryptors.delete(viewId)
  runtime.attachmentMetadata.delete(viewId)
  runtime.incomingTransfers.delete(viewId)
  const reserved = runtime.attachmentReservations.get(viewId)
  if (reserved !== undefined) {
    runtime.retainedAttachmentBytes = Math.max(0, runtime.retainedAttachmentBytes - reserved)
    runtime.attachmentReservations.delete(viewId)
  }
}

function cancelTransfers(runtime: SessionRuntime): void {
  runtime.transferEpoch += 1
  for (const controller of runtime.outboundTransfers.values()) controller.abort()
  runtime.outboundTransfers.clear()
  for (const viewId of [...runtime.decryptors.keys()]) releaseAttachment(runtime, viewId)
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function attachmentViewId(senderId: string, attachmentId: string): string {
  return `${senderId}:${attachmentId}`
}

function boundedUtf8ByteLength(value: string, stopAfter: number): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit < 0x80) bytes += 1
    else if (codeUnit < 0x800) bytes += 2
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
    if (bytes > stopAfter) return bytes
  }
  return bytes
}

function countKeysForPeer(values: Iterable<string>, memberId: string): number {
  const prefix = `${memberId}:`
  let count = 0
  for (const key of values) {
    if (key.startsWith(prefix)) count += 1
  }
  return count
}

function acceptPeerFrame(runtime: SessionRuntime, sourceMemberId: string, bytes: number): boolean {
  const now = Date.now()
  let window = runtime.peerRateWindows.get(sourceMemberId)
  if (!window || now - window.startedAt >= 1_000) {
    window = { startedAt: now, frames: 0, bytes: 0 }
    runtime.peerRateWindows.set(sourceMemberId, window)
  }
  if (
    window.frames + 1 > MAX_PEER_FRAMES_PER_SECOND ||
    window.bytes + bytes > MAX_PEER_BYTES_PER_SECOND
  ) {
    return false
  }
  window.frames += 1
  window.bytes += bytes
  return true
}

export default function App() {
  const [preferences, setPreferences] = usePreferences()
  const preferencesRef = useRef(preferences)
  const initialRoomId = useRef(routeRoomId())
  const [linkSecret, setLinkSecret] = useState<string | undefined>(() => {
    const secret = window.__VEILINK_BOOTSTRAP_SECRET__
    delete window.__VEILINK_BOOTSTRAP_SECRET__
    return secret
  })
  const [stage, setStage] = useState<Stage>(initialRoomId.current ? 'join' : 'create')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [room, setRoom] = useState<ActiveRoom>()
  const roomRef = useRef<ActiveRoom | undefined>(undefined)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [transportReady, setTransportReady] = useState(false)
  const messagesRef = useRef<ChatMessage[]>([])
  const runtimeRef = useRef<SessionRuntime | undefined>(undefined)
  const pendingJoinRef = useRef<PendingJoin | undefined>(undefined)
  const entryIdentityRef = useRef<SessionIdentity | undefined>(undefined)
  const entryIdentityGenerationRef = useRef(0)
  const stopRuntimeRef = useRef<(sendLeave: boolean) => void>(() => undefined)
  const [createdDetails, setCreatedDetails] = useState<{ pin: string; invitation: string }>()
  const [entryIdentityPublicKey, setEntryIdentityPublicKey] = useState<string>()
  const [entryIdentityBusy, setEntryIdentityBusy] = useState(false)

  const discardEntryIdentity = useCallback((): void => {
    entryIdentityGenerationRef.current += 1
    const identity = entryIdentityRef.current
    entryIdentityRef.current = undefined
    if (identity) destroyIdentity(identity)
  }, [])

  const regenerateEntryIdentity = useCallback(async (): Promise<void> => {
    const generation = entryIdentityGenerationRef.current + 1
    entryIdentityGenerationRef.current = generation
    setEntryIdentityBusy(true)
    try {
      const identity = await createSessionIdentity()
      if (entryIdentityGenerationRef.current !== generation) {
        destroyIdentity(identity)
        return
      }
      const previous = entryIdentityRef.current
      entryIdentityRef.current = identity
      setEntryIdentityPublicKey(bytesToBase64Url(identity.publicKey))
      if (previous) destroyIdentity(previous)
    } catch (caught) {
      if (entryIdentityGenerationRef.current === generation) {
        setError(caught instanceof Error ? caught.message : '无法生成随机头像')
      }
    } finally {
      if (entryIdentityGenerationRef.current === generation) setEntryIdentityBusy(false)
    }
  }, [])

  const takeEntryIdentity = (): SessionIdentity | undefined => {
    const identity = entryIdentityRef.current
    if (!identity) return undefined
    entryIdentityRef.current = undefined
    setEntryIdentityPublicKey(undefined)
    return identity
  }

  useEffect(() => {
    preferencesRef.current = preferences
  }, [preferences])

  useEffect(() => {
    if (
      (stage === 'create' || stage === 'join') &&
      !busy &&
      !entryIdentityBusy &&
      !entryIdentityRef.current &&
      !pendingJoinRef.current &&
      !runtimeRef.current
    ) {
      void regenerateEntryIdentity()
    }
  }, [busy, entryIdentityBusy, regenerateEntryIdentity, stage])

  const updateRoom = (next: ActiveRoom | ((current: ActiveRoom) => ActiveRoom)): void => {
    const resolved = typeof next === 'function'
      ? roomRef.current ? next(roomRef.current) : undefined
      : next
    if (!resolved) return
    roomRef.current = resolved
    setRoom(resolved)
  }

  const updateMessages = (updater: (current: ChatMessage[]) => ChatMessage[]): void => {
    let next = updater(messagesRef.current)
    if (next.length > MAX_MESSAGES_IN_MEMORY) {
      const removed = next.slice(0, next.length - MAX_MESSAGES_IN_MEMORY)
      const runtime = runtimeRef.current
      for (const message of removed) {
        for (const attachment of message.attachments) {
          if (attachment.objectUrl) URL.revokeObjectURL(attachment.objectUrl)
          if (runtime) releaseAttachment(runtime, attachment.id)
        }
      }
      next = next.slice(-MAX_MESSAGES_IN_MEMORY)
    }
    messagesRef.current = next
    setMessages(next)
  }

  const updateAttachment = (attachmentId: string, patchValue: Partial<AttachmentView>): void => {
    updateMessages((current) => current.map((message) => ({
      ...message,
      attachments: message.attachments.map((attachment) => attachment.id === attachmentId ? { ...attachment, ...patchValue } : attachment),
    })))
  }

  const completeInitialConnectionIfReady = (runtime: SessionRuntime): void => {
    if (
      runtime.initialConnectionComplete ||
      runtime.peerConnectionTimers.size > 0 ||
      runtimeRef.current !== runtime
    ) return
    runtime.initialConnectionComplete = true
    runtime.initialPeerIds.clear()
    setTransportReady(true)
  }

  const clearPeerConnectionTimer = (runtime: SessionRuntime, memberId: string): void => {
    const timer = runtime.peerConnectionTimers.get(memberId)
    if (timer !== undefined) window.clearTimeout(timer)
    runtime.peerConnectionTimers.delete(memberId)
    completeInitialConnectionIfReady(runtime)
  }

  const clearPeerConnectionTimers = (runtime: SessionRuntime): void => {
    for (const timer of runtime.peerConnectionTimers.values()) window.clearTimeout(timer)
    runtime.peerConnectionTimers.clear()
  }

  const armPeerConnectionTimer = (runtime: SessionRuntime, memberId: string): void => {
    if (
      runtimeRef.current !== runtime ||
      runtime.initialConnectionComplete ||
      !runtime.initialPeerIds.has(memberId) ||
      !roomRef.current?.members.some((member) => member.id === memberId) ||
      memberId === roomRef.current?.memberId ||
      runtime.mesh.connectedMemberIds().includes(memberId) ||
      runtime.peerConnectionTimers.has(memberId)
    ) return
    setTransportReady(false)
    const timer = window.setTimeout(() => {
      runtime.peerConnectionTimers.delete(memberId)
      if (
        runtimeRef.current !== runtime ||
        runtime.initialConnectionComplete ||
        !runtime.initialPeerIds.has(memberId) ||
        !roomRef.current?.members.some((member) => member.id === memberId) ||
        runtime.mesh.connectedMemberIds().includes(memberId)
      ) {
        completeInitialConnectionIfReady(runtime)
        return
      }
      setError('连接超时，已自动退出聊天室，请重试。')
      stopRuntime(true)
      window.history.replaceState(null, '', '/')
      initialRoomId.current = undefined
      setStage('create')
    }, PEER_CONNECTION_TIMEOUT_MS)
    runtime.peerConnectionTimers.set(memberId, timer)
  }

  const armRoomConnectionTimers = (runtime: SessionRuntime, members: Member[]): void => {
    const memberIds = new Set(members.map((member) => member.id))
    for (const memberId of [...runtime.initialPeerIds]) {
      if (memberIds.has(memberId)) continue
      runtime.initialPeerIds.delete(memberId)
      clearPeerConnectionTimer(runtime, memberId)
    }
    for (const memberId of runtime.initialPeerIds) armPeerConnectionTimer(runtime, memberId)
    completeInitialConnectionIfReady(runtime)
  }

  const registerPeerFrameViolation = (runtime: SessionRuntime, sourceMemberId: string): void => {
    const now = Date.now()
    let violationWindow = runtime.peerViolationWindows.get(sourceMemberId)
    if (!violationWindow || now - violationWindow.startedAt >= PEER_FRAME_VIOLATION_WINDOW_MS) {
      violationWindow = { startedAt: now, violations: 0 }
      runtime.peerViolationWindows.set(sourceMemberId, violationWindow)
    }
    violationWindow.violations += 1
    if (violationWindow.violations < MAX_PEER_FRAME_VIOLATIONS || runtimeRef.current !== runtime) return
    setError('检测到成员持续发送无效或超限数据，已为保护本机内存自动退出。')
    stopRuntime(true)
    window.history.replaceState(null, '', '/')
    initialRoomId.current = undefined
    setStage('create')
  }

  const armIncomingTransferTimer = (runtime: SessionRuntime, viewId: string): void => {
    const currentTimer = runtime.incomingTransferTimers.get(viewId)
    if (currentTimer !== undefined) window.clearTimeout(currentTimer)
    const timer = window.setTimeout(() => {
      if (runtimeRef.current !== runtime || !runtime.incomingTransfers.has(viewId)) return
      releaseAttachment(runtime, viewId)
      updateAttachment(viewId, { status: 'cancelled', progress: 0 })
    }, INCOMING_TRANSFER_IDLE_TIMEOUT_MS)
    runtime.incomingTransferTimers.set(viewId, timer)
  }

  const stopRuntime = (sendLeave: boolean): void => {
    const runtime = runtimeRef.current
    if (runtime) {
      runtime.unsubscribe()
      clearPeerConnectionTimers(runtime)
      runtime.mesh.destroy()
      cancelTransfers(runtime)
      if (runtime.turnRefreshTimer !== undefined) window.clearTimeout(runtime.turnRefreshTimer)
      if (sendLeave) runtime.signal.leave()
      else runtime.signal.close()
      destroyIdentity(runtime.identity)
      wipeKeys(runtime.keys)
    }
    const pending = pendingJoinRef.current
    if (pending) disposePendingJoin(pending)
    pendingJoinRef.current = undefined
    for (const message of messagesRef.current) {
      for (const attachment of message.attachments) {
        if (attachment.objectUrl) URL.revokeObjectURL(attachment.objectUrl)
        if (runtime) releaseAttachment(runtime, attachment.id)
      }
    }
    if (runtime) {
      runtime.replayCounters.clear()
      runtime.peerRateWindows.clear()
      runtime.peerViolationWindows.clear()
      runtime.peerDataQueues.clear()
      runtime.attachmentMetadata.clear()
      runtime.attachmentReservations.clear()
      runtime.incomingTransferTimers.clear()
      runtime.incomingTransfers.clear()
      runtime.seenAttachments.clear()
      runtime.retainedAttachmentBytes = 0
    }
    runtimeRef.current = undefined
    setTransportReady(false)
    messagesRef.current = []
    setMessages([])
    roomRef.current = undefined
    setRoom(undefined)
    setLinkSecret(undefined)
    setCreatedDetails(undefined)
  }
  stopRuntimeRef.current = stopRuntime

  useEffect(() => {
    const pageHide = (): void => {
      stopRuntimeRef.current(true)
      discardEntryIdentity()
      initialRoomId.current = undefined
      window.history.replaceState(null, '', '/')
      setStage('create')
    }
    window.addEventListener('pagehide', pageHide)
    return () => {
      window.removeEventListener('pagehide', pageHide)
      stopRuntimeRef.current(true)
      discardEntryIdentity()
    }
  }, [discardEntryIdentity])

  const scheduleTurnRefresh = (runtime: SessionRuntime, credentials: TurnCredentials): void => {
    if (runtime.turnRefreshTimer !== undefined) window.clearTimeout(runtime.turnRefreshTimer)
    const remaining = Math.max(0, credentials.expiresAt - Date.now())
    const refreshLead = Math.min(15 * 60_000, Math.max(60_000, Math.floor(remaining / 3)))
    const delay = Math.max(30_000, remaining - refreshLead)
    runtime.turnRefreshTimer = window.setTimeout(() => {
      void (async () => {
        try {
          const refreshed = await runtime.signal.requestTurnCredentials()
          await runtime.mesh.refreshTurnCredentials(turnIce(refreshed))
          scheduleTurnRefresh(runtime, refreshed)
        } catch {
          setError('TURN 临时凭据刷新失败，请重新进入房间。')
        }
      })()
    }, delay)
  }

  const processData = async (sourceMemberId: string, raw: string | ArrayBuffer): Promise<void> => {
    const runtime = runtimeRef.current
    const currentRoom = roomRef.current
    if (!runtime || !currentRoom) return
    const sender = currentRoom.members.find((member) => member.id === sourceMemberId)
    if (!sender) return
    const byteLength = typeof raw === 'string'
      ? boundedUtf8ByteLength(raw, MAX_PEER_BYTES_PER_SECOND)
      : raw.byteLength
    if (!acceptPeerFrame(runtime, sourceMemberId, byteLength)) {
      registerPeerFrameViolation(runtime, sourceMemberId)
      return
    }
    if (typeof raw !== 'string' || byteLength > MAX_DATA_FRAME_BYTES) {
      registerPeerFrameViolation(runtime, sourceMemberId)
      return
    }
    let value: unknown
    try { value = JSON.parse(raw) as unknown } catch { return }

    const chatFrame = EncryptedChatFrameSchema.safeParse(value)
    if (chatFrame.success) {
      const frame = chatFrame.data
      if (frame.senderId !== sourceMemberId) return
      const replayKey = `${frame.senderId}:${frame.sessionId}`
      if (
        !runtime.replayCounters.has(replayKey) &&
        countKeysForPeer(runtime.replayCounters.keys(), frame.senderId) >= MAX_REPLAY_SESSIONS_PER_PEER
      ) return
      try {
        const decrypted = await decryptChatPayload<unknown>(
          frame,
          runtime.keys.messageKey,
          IdentityPublicKeySchema.parse(sender.identityPublicKey),
        )
        const payload = ChatPayloadSchema.parse(decrypted)
        const replayCounters = acceptReplayCounter(
          runtime.replayCounters,
          frame.senderId,
          frame.sessionId,
          frame.counter,
        )
        if (!replayCounters) return
        runtime.replayCounters = replayCounters
        await processPayload(payload, sender, frame.sentAt, frame.messageId)
      } catch {
        return
      }
      return
    }

    const chunkFrame = EncryptedFileChunkSchema.safeParse(value)
    if (!chunkFrame.success) return
    const frame = chunkFrame.data
    const viewId = attachmentViewId(sourceMemberId, frame.attachmentId)
    const decryptor = runtime.decryptors.get(viewId)
    const metadata = runtime.attachmentMetadata.get(viewId)
    if (!decryptor || !metadata) return
    try {
      const blob = decryptor.push({
        fileId: frame.attachmentId,
        index: frame.chunkIndex,
        ciphertext: frame.ciphertext,
        final: frame.final,
      })
      armIncomingTransferTimer(runtime, viewId)
      updateAttachment(viewId, {
        status: frame.final ? 'receiving' : 'receiving',
        progress: Math.min(1, ((frame.chunkIndex + 1) * metadata.chunkSize) / metadata.size),
      })
      if (blob) {
        if (blob.size !== metadata.size) throw new Error('Received file length does not match the offer')
        const bytes = new Uint8Array(await blob.slice(0, Math.min(blob.size, 8_192)).arrayBuffer())
        let media: Awaited<ReturnType<typeof validateMedia>>
        let safeBlob: Blob
        try {
          media = await validateMedia(bytes, metadata.mimeType)
          safeBlob = blob.slice(0, blob.size, media.previewable ? media.mime : 'application/octet-stream')
        } finally {
          bytes.fill(0)
        }
        const objectUrl = URL.createObjectURL(safeBlob)
        updateAttachment(viewId, { status: 'ready', progress: 1, mime: media.mime, previewable: media.previewable, objectUrl })
        runtime.decryptors.delete(viewId)
        runtime.attachmentMetadata.delete(viewId)
        runtime.incomingTransfers.delete(viewId)
        const transferTimer = runtime.incomingTransferTimers.get(viewId)
        if (transferTimer !== undefined) window.clearTimeout(transferTimer)
        runtime.incomingTransferTimers.delete(viewId)
      }
    } catch {
      releaseAttachment(runtime, viewId)
      updateAttachment(viewId, { status: 'rejected', progress: 0 })
    }
  }

  const processPayload = async (payload: ChatPayload, sender: Member, sentAt: number, messageId: string): Promise<void> => {
    const runtime = runtimeRef.current
    if (!runtime) return
    if (payload.type === 'rich-text') {
      updateMessages((current) => [...current, {
        id: `${sender.id}:${messageId}`,
        senderId: sender.id,
        senderName: sender.nickname,
        senderIdentityPublicKey: sender.identityPublicKey,
        sentAt,
        document: payload.document as RichTextDocument,
        attachments: [],
      }])
      return
    }
    if (payload.type === 'attachment-offer') {
      const metadata = payload.attachment
      const viewId = attachmentViewId(sender.id, metadata.attachmentId)
      if (
        runtime.seenAttachments.has(viewId) ||
        countKeysForPeer(runtime.seenAttachments, sender.id) >= MAX_SEEN_ATTACHMENTS_PER_PEER
      ) return
      runtime.seenAttachments.add(viewId)
      const maxBytes = preferencesRef.current.maxFileSizeMb * 1024 * 1024
      const retainedLimit = Math.min(MAX_RETAINED_ATTACHMENT_BYTES, maxBytes * 4)
      let accepted = metadata.size <= maxBytes &&
        runtime.incomingTransfers.size < MAX_CONCURRENT_INCOMING_FILES &&
        runtime.retainedAttachmentBytes + metadata.size <= retainedLimit
      if (accepted) {
        runtime.incomingTransfers.add(viewId)
        runtime.attachmentReservations.set(viewId, metadata.size)
        runtime.retainedAttachmentBytes += metadata.size
        try {
          const decryptor = await FileDecryptor.create(
            metadata.attachmentId,
            runtime.keys.fileKey,
            metadata.secretstreamHeader,
            {
              digest: metadata.digest,
              size: metadata.size,
              chunkSize: metadata.chunkSize,
              chunkCount: metadata.chunkCount,
            },
          )
          if (runtimeRef.current !== runtime) {
            decryptor.destroy()
            releaseAttachment(runtime, viewId)
            return
          }
          runtime.decryptors.set(viewId, decryptor)
          runtime.attachmentMetadata.set(viewId, metadata)
          armIncomingTransferTimer(runtime, viewId)
        } catch {
          accepted = false
          releaseAttachment(runtime, viewId)
        }
      }
      updateMessages((current) => [...current, {
        id: `${sender.id}:${messageId}`,
        senderId: sender.id,
        senderName: sender.nickname,
        senderIdentityPublicKey: sender.identityPublicKey,
        sentAt,
        document: attachmentDocument(metadata.fileName),
        attachments: [{
          id: viewId,
          name: metadata.fileName,
          mime: metadata.mimeType,
          size: metadata.size,
          status: accepted ? 'receiving' : 'rejected',
          progress: 0,
          previewable: false,
        }],
      }])
      return
    }
    updateAttachment(attachmentViewId(sender.id, payload.attachmentId), {
      status: payload.state === 'complete'
        ? 'ready'
        : payload.state === 'failed' || payload.state === 'declined'
          ? 'rejected'
          : payload.state === 'cancelled'
            ? 'cancelled'
            : 'receiving',
      progress: 0,
    })
  }

  const setupRuntime = async (
    confirmation: SessionConfirmation,
    signal: SignalClient,
    identity: SessionIdentity,
    keys: DerivedKeys,
    secret: string,
  ): Promise<ActiveRoom> => {
    const initialRoom = activeRoomFromSnapshot(confirmation.snapshot, confirmation.selfMemberId, keys, secret)
    const turnCredentials = await signal.requestTurnCredentials()
    const runtime = {} as SessionRuntime
    const mesh = new PeerMesh({
      localMemberId: initialRoom.memberId,
      turnCredentials: turnIce(turnCredentials),
      sendSignal: (targetMemberId, payload) => {
        if (payload.description) signal.sendRtcDescription(targetMemberId as never, payload.description)
        if (payload.candidate) signal.sendRtcCandidate(targetMemberId as never, payload.candidate)
      },
      onData: (sourceMemberId, data) => {
        const previous = runtime.peerDataQueues.get(sourceMemberId) ?? Promise.resolve()
        const next = previous
          .catch(() => undefined)
          .then(() => processData(sourceMemberId, data))
          .catch(() => undefined)
        runtime.peerDataQueues.set(sourceMemberId, next)
        void next.then(() => {
          if (runtime.peerDataQueues.get(sourceMemberId) === next) runtime.peerDataQueues.delete(sourceMemberId)
        })
      },
      onConnectionChange: (memberId, state) => {
        if (state === 'failed') armPeerConnectionTimer(runtime, memberId)
      },
      onChannelChange: (memberId, state) => {
        if (state === 'open') clearPeerConnectionTimer(runtime, memberId)
        if (state === 'closed') armPeerConnectionTimer(runtime, memberId)
      },
    })
    const unsubscribe = signal.subscribe((frame) => {
      void handleServerFrame(frame).catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : '无法处理服务器状态更新')
        if (frame.type === 'room.resumed' || frame.type === 'room.snapshot') {
          stopRuntime(false)
          window.history.replaceState(null, '', '/')
          initialRoomId.current = undefined
          setStage('create')
        }
      })
    })
    Object.assign(runtime, {
      signal,
      identity,
      mesh,
      keys,
      linkSecret: secret,
      replayCounters: new Map(),
      peerRateWindows: new Map(),
      peerViolationWindows: new Map(),
      peerDataQueues: new Map(),
      peerConnectionTimers: new Map(),
      initialPeerIds: new Set(initialRoom.members
        .map((member) => member.id)
        .filter((memberId) => memberId !== initialRoom.memberId)),
      initialConnectionComplete: false,
      decryptors: new Map(),
      attachmentMetadata: new Map(),
      attachmentReservations: new Map(),
      incomingTransferTimers: new Map(),
      incomingTransfers: new Set(),
      retainedAttachmentBytes: 0,
      seenAttachments: new Set(),
      outboundTransfers: new Map(),
      transferEpoch: 0,
      unsubscribe,
    } satisfies SessionRuntime)
    runtimeRef.current = runtime
    updateRoom(initialRoom)
    mesh.syncMembers(initialRoom.members)
    armRoomConnectionTimers(runtime, initialRoom.members)
    scheduleTurnRefresh(runtime, turnCredentials)
    return initialRoom
  }

  const handleServerFrame = async (frame: ServerSignalEnvelope): Promise<void> => {
    const runtime = runtimeRef.current
    const current = roomRef.current
    if (!runtime || !current || ('roomId' in frame && frame.roomId && frame.roomId !== current.roomId)) return
    if (frame.type === 'room.snapshot' || frame.type === 'room.resumed') {
      const snapshot = frame.type === 'room.snapshot' ? frame.payload : frame.payload.snapshot
      const next = activeRoomFromSnapshot(snapshot, current.memberId, current.keys, current.linkSecret)
      updateRoom(next)
      runtime.mesh.syncMembers(next.members)
      armRoomConnectionTimers(runtime, next.members)
      return
    }
    if (frame.type === 'room.member.joined') {
      const member = memberFromWire(frame.payload.member)
      updateRoom((value) => ({ ...value, members: [...value.members.filter((item) => item.id !== member.id), member] }))
      const members = [...(roomRef.current?.members ?? [])]
      runtime.mesh.syncMembers(members)
      armPeerConnectionTimer(runtime, member.id)
      return
    }
    if (frame.type === 'room.member.left') {
      runtime.initialPeerIds.delete(frame.payload.memberId)
      clearPeerConnectionTimer(runtime, frame.payload.memberId)
      runtime.mesh.removePeer(frame.payload.memberId)
      runtime.peerRateWindows.delete(frame.payload.memberId)
      runtime.peerViolationWindows.delete(frame.payload.memberId)
      runtime.peerDataQueues.delete(frame.payload.memberId)
      for (const key of [...runtime.replayCounters.keys()]) {
        if (key.startsWith(`${frame.payload.memberId}:`)) runtime.replayCounters.delete(key)
      }
      const activeAttachmentPrefix = `${frame.payload.memberId}:`
      for (const viewId of [...runtime.seenAttachments]) {
        if (viewId.startsWith(activeAttachmentPrefix)) runtime.seenAttachments.delete(viewId)
      }
      for (const viewId of [...runtime.decryptors.keys()]) {
        if (viewId.startsWith(activeAttachmentPrefix)) releaseAttachment(runtime, viewId)
      }
      updateMessages((currentMessages) => currentMessages.map((message) => ({
        ...message,
        attachments: message.attachments.map((attachment) =>
          attachment.id.startsWith(activeAttachmentPrefix) && attachment.status === 'receiving'
            ? { ...attachment, status: 'cancelled' }
            : attachment),
      })))
      updateRoom((value) => ({ ...value, members: value.members.filter((member) => member.id !== frame.payload.memberId) }))
      return
    }
    if (frame.type === 'room.owner.changed') {
      updateRoom((value) => ({
        ...value,
        ownerId: frame.payload.ownerId,
        members: value.members.map((member) => ({ ...member, isOwner: member.id === frame.payload.ownerId })),
      }))
      return
    }
    if (frame.type === 'rtc.description' || frame.type === 'rtc.candidate') {
      const payload: PeerSignalPayload = frame.type === 'rtc.description'
        ? { description: frame.payload.description as RTCSessionDescriptionInit }
        : { candidate: frame.payload.candidate as RTCIceCandidateInit }
      await runtime.mesh.handleSignal(frame.payload.fromMemberId, payload)
      return
    }
    if (frame.type === 'room.ended') {
      stopRuntime(false)
      setError(`聊天室已结束：${frame.payload.reason}`)
      window.history.replaceState(null, '', '/')
      setStage('create')
      return
    }
    if (frame.type === 'error') {
      setError(frame.payload.message)
      if (frame.payload.code === 'resume_rejected' || frame.payload.code === 'member_not_found') {
        stopRuntime(false)
        window.history.replaceState(null, '', '/')
        initialRoomId.current = undefined
        setStage('create')
      }
    }
  }

  const rememberNickname = (nickname: string): void => {
    if (preferences.rememberNickname) setPreferences({ ...preferences, nickname })
  }

  const createRoom = async (rawNickname: string): Promise<void> => {
    const entryIdentity = takeEntryIdentity()
    if (!entryIdentity) {
      setError('随机头像仍在生成，请稍候重试。')
      return
    }
    setBusy(true)
    setError(undefined)
    let keys: DerivedKeys | undefined
    let identity: SessionIdentity | undefined = entryIdentity
    let signal: SignalClient | undefined
    try {
      const nickname = NicknameSchema.parse(rawNickname)
      const roomId = generateRoomId()
      const secret = generateLinkSecret()
      const pin = generatePin()
      await loadPublicConfig()
      keys = await deriveRoomKeys(pin, roomId, secret)
      signal = new SignalClient(roomId)
      const confirmation = await signal.createRoom({
        nickname,
        admissionKey: keys.admissionKey,
        identityPublicKey: IdentityPublicKeySchema.parse(bytesToBase64Url(identity.publicKey)),
      })
      await setupRuntime(confirmation, signal, identity, keys, secret)
      keys = undefined
      identity = undefined
      signal = undefined
      const path = buildInvitePath(roomId, secret)
      const invitation = `${window.location.origin}${path}`
      window.history.replaceState(null, '', `/room/${roomId}`)
      initialRoomId.current = roomId
      setLinkSecret(secret)
      rememberNickname(nickname)
      setCreatedDetails({ pin, invitation })
      setStage('created')
    } catch (caught) {
      stopRuntime(false)
      signal?.close()
      if (identity) destroyIdentity(identity)
      if (keys) wipeKeys(keys)
      setError(caught instanceof Error ? caught.message : '创建聊天室失败')
    } finally {
      setBusy(false)
    }
  }

  const finishPendingJoin = async (): Promise<void> => {
    const pending = pendingJoinRef.current
    if (!pending) return
    setBusy(true)
    setError(undefined)
    try {
      const confirmation = await pending.signal.finishJoin({
        nickname: pending.nickname,
        identityPublicKey: IdentityPublicKeySchema.parse(bytesToBase64Url(pending.identity.publicKey)),
        admissionKey: pending.keys.admissionKey,
        challengeId: pending.challenge.challengeId,
        challenge: pending.challenge.challenge,
      })
      await setupRuntime(confirmation, pending.signal, pending.identity, pending.keys, linkSecret!)
      rememberNickname(pending.nickname)
      pendingJoinRef.current = undefined
      setStage('room')
    } catch (caught) {
      if (runtimeRef.current?.identity === pending.identity) {
        pendingJoinRef.current = undefined
        stopRuntime(false)
      } else {
        disposePendingJoin(pending)
        pendingJoinRef.current = undefined
      }
      setError(caught instanceof Error ? caught.message : '加入聊天室失败')
      setStage('join')
    } finally {
      setBusy(false)
    }
  }

  const joinRoom = async (rawNickname: string, pin: string): Promise<void> => {
    if (!initialRoomId.current || !linkSecret) return
    const entryIdentity = takeEntryIdentity()
    if (!entryIdentity) {
      setError('随机头像仍在生成，请稍候重试。')
      return
    }
    setBusy(true)
    setError(undefined)
    let keys: DerivedKeys | undefined
    let identity: SessionIdentity | undefined = entryIdentity
    let signal: SignalClient | undefined
    try {
      const nickname = NicknameSchema.parse(rawNickname)
      await loadPublicConfig()
      keys = await deriveRoomKeys(pin, initialRoomId.current, linkSecret)
      signal = new SignalClient(initialRoomId.current)
      const challenge = await signal.beginJoin(nickname, IdentityPublicKeySchema.parse(bytesToBase64Url(identity.publicKey)))
      pendingJoinRef.current = { nickname, identity, signal, keys, challenge }
      keys = undefined
      identity = undefined
      signal = undefined
      await finishPendingJoin()
    } catch (caught) {
      signal?.close()
      if (identity) destroyIdentity(identity)
      if (keys) wipeKeys(keys)
      setError(caught instanceof Error ? caught.message : '加入聊天室失败')
    } finally {
      setBusy(false)
    }
  }

  const sendPayload = async (payload: ChatPayload): Promise<string> => {
    const runtime = runtimeRef.current
    const current = roomRef.current
    if (!runtime || !current) throw new Error('安全连接尚未就绪')
    const validated = ChatPayloadSchema.parse(payload)
    const frame = await encryptChatPayload(validated, current.memberId, runtime.identity, runtime.keys.messageKey)
    await runtime.mesh.broadcast(JSON.stringify(frame))
    return frame.messageId
  }

  const sendDocument = async (document: RichTextDocument): Promise<void> => {
    const current = roomRef.current
    if (!current) return
    try {
      setError(undefined)
      const payload = ChatPayloadSchema.parse({ type: 'rich-text', document })
      if (payload.type !== 'rich-text') throw new Error('Invalid rich-text payload')
      const messageId = await sendPayload(payload)
      const self = current.members.find((member) => member.id === current.memberId)
      if (!self) return
      updateMessages((items) => [...items, {
        id: `${self.id}:${messageId}`,
        senderId: self.id,
        senderName: self.nickname,
        senderIdentityPublicKey: self.identityPublicKey,
        sentAt: Date.now(),
        document: payload.document as RichTextDocument,
        attachments: [],
      }])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '消息发送失败')
      throw caught
    }
  }

  const sendFiles = async (files: File[]): Promise<void> => {
    const runtime = runtimeRef.current
    const current = roomRef.current
    const self = current?.members.find((member) => member.id === current.memberId)
    if (!runtime || !current || !self) return
    const accepted = files.slice(0, 4)
    const transferEpoch = runtime.transferEpoch
    for (const file of accepted) {
      if (runtimeRef.current !== runtime || runtime.transferEpoch !== transferEpoch) break
      const maxBytes = preferences.maxFileSizeMb * 1024 * 1024
      if (file.size < 1 || file.size > maxBytes) {
        setError(`文件 ${file.name} 超出本地 ${preferences.maxFileSizeMb} MiB 上限`)
        continue
      }
      const fileName = normalizeFileName(file.name)
      const attachmentId = randomId(16)
      const viewId = attachmentViewId(self.id, attachmentId)
      const controller = new AbortController()
      runtime.outboundTransfers.set(attachmentId, controller)
      let metadata: AttachmentMetadata | undefined
      let objectUrl: string | undefined
      try {
        const headerBytes = new Uint8Array(await file.slice(0, Math.min(file.size, 8192)).arrayBuffer())
        let validatedMedia: Awaited<ReturnType<typeof validateMedia>>
        try {
          if (controller.signal.aborted) throw new DOMException('File transfer cancelled', 'AbortError')
          validatedMedia = await validateMedia(headerBytes, file.type || 'application/octet-stream')
        } finally {
          headerBytes.fill(0)
        }
        const digest = await hashFile(file, controller.signal)
        if (runtimeRef.current !== runtime) controller.abort()
        if (controller.signal.aborted) throw new DOMException('File transfer cancelled', 'AbortError')
        objectUrl = URL.createObjectURL(file)
        await encryptFile(
          file,
          attachmentId,
          runtime.keys.fileKey,
          async (start) => {
            metadata = AttachmentMetadataSchema.parse({
              attachmentId,
              fileName,
              size: file.size,
              mimeType: validatedMedia.mime,
              digest,
              previewKind: previewKind(validatedMedia.mime, validatedMedia.previewable),
              chunkSize: 64 * 1024,
              chunkCount: Math.ceil(file.size / (64 * 1024)),
              secretstreamHeader: start.header,
            })
            if (controller.signal.aborted) throw new DOMException('File transfer cancelled', 'AbortError')
            const messageId = await sendPayload({ type: 'attachment-offer', attachment: metadata })
            if (controller.signal.aborted) throw new DOMException('File transfer cancelled', 'AbortError')
            updateMessages((items) => [...items, {
              id: `${self.id}:${messageId}`,
              senderId: self.id,
              senderName: self.nickname,
              senderIdentityPublicKey: self.identityPublicKey,
              sentAt: Date.now(),
              document: attachmentDocument(fileName),
              attachments: [{ id: viewId, name: fileName, mime: metadata!.mimeType, size: file.size, status: 'sending', progress: 0, previewable: validatedMedia.previewable, objectUrl }],
            }])
          },
          async (chunk: LocalEncryptedFileChunk) => {
            if (controller.signal.aborted) throw new DOMException('File transfer cancelled', 'AbortError')
            const wire: EncryptedFileChunk = EncryptedFileChunkSchema.parse({
              v: PROTOCOL_VERSION,
              type: 'file-chunk',
              attachmentId,
              chunkIndex: chunk.index,
              final: chunk.final,
              ciphertext: chunk.ciphertext,
            })
            await runtime.mesh.broadcast(JSON.stringify(wire))
            if (controller.signal.aborted) throw new DOMException('File transfer cancelled', 'AbortError')
            updateAttachment(viewId, { status: chunk.final ? 'ready' : 'sending', progress: Math.min(1, ((chunk.index + 1) * 64 * 1024) / file.size) })
          },
          controller.signal,
        )
      } catch (caught) {
        if (objectUrl) URL.revokeObjectURL(objectUrl)
        const cancelled = isAbortError(caught)
        updateAttachment(viewId, { status: cancelled ? 'cancelled' : 'rejected', progress: 0, objectUrl: undefined })
        if (!cancelled) setError(caught instanceof Error ? caught.message : `发送 ${fileName} 失败`)
        if (cancelled) break
      } finally {
        if (runtime.outboundTransfers.get(attachmentId) === controller) {
          runtime.outboundTransfers.delete(attachmentId)
        }
      }
    }
  }

  const leaveRoom = (): void => {
    stopRuntime(true)
    setLinkSecret(undefined)
    window.history.replaceState(null, '', '/')
    initialRoomId.current = undefined
    setStage('create')
  }

  const destroyRoom = async (): Promise<void> => {
    const current = roomRef.current
    const runtime = runtimeRef.current
    if (!current || !runtime) return
    runtime.signal.destroyRoom()
  }

  if (stage === 'room' && room) {
    return <RoomShell room={room} messages={messages} preferences={preferences} connectionState={transportReady ? 'ready' : 'connecting'} error={error} onPreferences={setPreferences} onSend={sendDocument} onFiles={sendFiles} onLeave={leaveRoom} onDestroy={destroyRoom} />
  }

  return (
    <EntryShell preferences={preferences} onPreferences={setPreferences}>
      {stage === 'create' ? <CreateRoomView preferences={preferences} busy={busy} avatarSeed={entryIdentityPublicKey} avatarBusy={entryIdentityBusy} error={error} onRegenerateAvatar={regenerateEntryIdentity} onCreate={createRoom} /> : null}
      {stage === 'join' ? <JoinRoomView preferences={preferences} hasLinkSecret={Boolean(linkSecret)} busy={busy} avatarSeed={entryIdentityPublicKey} avatarBusy={entryIdentityBusy} error={error} onRegenerateAvatar={regenerateEntryIdentity} onJoin={joinRoom} /> : null}
      {stage === 'created' && createdDetails ? <RoomCreatedView pin={createdDetails.pin} invitation={createdDetails.invitation} preferences={preferences} onContinue={() => { setCreatedDetails(undefined); setStage('room') }} /> : null}
    </EntryShell>
  )
}

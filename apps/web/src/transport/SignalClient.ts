import {
  PROTOCOL_VERSION,
  RoomIdSchema,
  base64UrlEncode,
  encodeAdmissionChallenge,
  generateRequestId,
  parseServerSignalEnvelope,
  type ClientSignalEnvelope,
  type Challenge,
  type ChallengeId,
  type IdentityPublicKey,
  type MemberId,
  type Nickname,
  type RoomId,
  type ServerSignalEnvelope,
  type SignalErrorCode,
  type ServerSignalType,
  type TurnCredentials,
} from '@veilink/protocol'

interface PendingRequest {
  expected: Set<ServerSignalType>
  resolve: (frame: ServerSignalEnvelope) => void
  reject: (error: Error) => void
  timeout: number
}

interface DeferredRtcFrame {
  frame: Extract<ServerSignalEnvelope, { type: 'rtc.description' | 'rtc.candidate' }>
  bytes: number
}

interface ResumeState {
  memberId: MemberId
  resumeToken: string
  identityPublicKey: IdentityPublicKey
}

export interface ResumeCredentials {
  memberId: MemberId
  resumeToken: string
  identityPublicKey: IdentityPublicKey
}

export interface SessionConfirmation {
  selfMemberId: MemberId
  resumeToken: string
  snapshot: Extract<ServerSignalEnvelope, { type: 'room.created' | 'room.joined' | 'room.resumed' }>['payload']['snapshot']
}

export class SignalRequestError extends Error {
  readonly code: SignalErrorCode
  readonly retryAfterMs?: number

  constructor(code: SignalErrorCode, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'SignalRequestError'
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

const MAX_DEFERRED_RTC_FRAMES = 512
const MAX_DEFERRED_RTC_BYTES = 2 * 1024 * 1024
const signalEncoder = new TextEncoder()

function socketUrl(): string {
  const url = new URL('/signal', window.location.origin)
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function admissionProof(key: Uint8Array, roomId: RoomId, challengeId: ChallengeId, challenge: Challenge): Promise<string> {
  const material = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const proof = await crypto.subtle.sign(
    'HMAC',
    material,
    toArrayBuffer(encodeAdmissionChallenge(roomId, challengeId, challenge)),
  )
  return base64UrlEncode(new Uint8Array(proof))
}

export class SignalClient {
  readonly roomId: RoomId
  private socket?: WebSocket
  private connectPromise?: Promise<void>
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<(frame: ServerSignalEnvelope) => void>()
  private readonly deferredRtcFrames: DeferredRtcFrame[] = []
  private deferredRtcBytes = 0
  private deferredRtcFlushScheduled = false
  private heartbeatTimer?: number
  private reconnectTimer?: number
  private reconnectStartedAt?: number
  private resumeState?: ResumeState
  private closed = false
  private readonly reconnectWindowMs: number

  constructor(roomId: string, reconnectGraceMs = 30_000) {
    this.roomId = RoomIdSchema.parse(roomId)
    this.reconnectWindowMs = Math.max(1_000, reconnectGraceMs - 2_000)
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.connectPromise) return this.connectPromise
    this.closed = false
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(socketUrl())
      this.socket = socket
      const timer = window.setTimeout(() => {
        socket.close()
        reject(new Error('Signaling connection timed out'))
      }, 12_000)
      socket.addEventListener('open', () => {
        window.clearTimeout(timer)
        resolve()
      }, { once: true })
      socket.addEventListener('error', () => {
        window.clearTimeout(timer)
        reject(new Error('Unable to connect to the signaling server'))
      }, { once: true })
      socket.addEventListener('message', (event) => this.handleMessage(event.data))
      socket.addEventListener('close', () => {
        this.stopHeartbeat()
        this.clearDeferredRtcFrames()
        for (const request of this.pending.values()) {
          window.clearTimeout(request.timeout)
          request.reject(new Error('Signaling connection closed'))
        }
        this.pending.clear()
        if (!this.closed && this.resumeState) this.scheduleReconnect()
      })
    }).finally(() => {
      this.connectPromise = undefined
    })
    return this.connectPromise
  }

  subscribe(listener: (frame: ServerSignalEnvelope) => void): () => void {
    this.listeners.add(listener)
    this.scheduleDeferredRtcFlush()
    return () => this.listeners.delete(listener)
  }

  async createRoom(input: {
    nickname: Nickname
    admissionKey: Uint8Array
    identityPublicKey: IdentityPublicKey
    creationPassword?: string
  }): Promise<SessionConfirmation> {
    if (input.creationPassword !== undefined && window.location.protocol !== 'https:') {
      throw new Error('Room creation passwords require HTTPS/WSS')
    }
    await this.connect()
    const response = await this.request({
      v: PROTOCOL_VERSION,
      type: 'room.create',
      requestId: generateRequestId(),
      roomId: this.roomId,
      payload: {
        nickname: input.nickname,
        admissionVerifier: base64UrlEncode(input.admissionKey) as never,
        identityPublicKey: input.identityPublicKey,
        ...(input.creationPassword !== undefined ? { creationPassword: input.creationPassword } : {}),
      },
    }, ['room.created'])
    if (response.type !== 'room.created') throw new Error('Unexpected create response')
    this.resumeState = {
      memberId: response.payload.selfMemberId,
      resumeToken: response.payload.resumeToken,
      identityPublicKey: input.identityPublicKey,
    }
    this.startHeartbeat()
    return response.payload
  }

  async requestTurnCredentials(): Promise<TurnCredentials> {
    const response = await this.request({
      v: PROTOCOL_VERSION,
      type: 'turn.credentials.refresh',
      requestId: generateRequestId(),
      roomId: this.roomId,
      payload: {},
    }, ['turn.credentials'])
    if (response.type !== 'turn.credentials') throw new Error('Unexpected TURN credential response')
    return response.payload
  }

  async beginJoin(nickname: Nickname, identityPublicKey: IdentityPublicKey): Promise<Extract<ServerSignalEnvelope, { type: 'room.challenge' }>['payload']> {
    await this.connect()
    const response = await this.request({
      v: PROTOCOL_VERSION,
      type: 'room.challenge',
      requestId: generateRequestId(),
      roomId: this.roomId,
      payload: { nickname, identityPublicKey },
    }, ['room.challenge'])
    if (response.type !== 'room.challenge') throw new Error('Unexpected challenge response')
    return response.payload
  }

  async finishJoin(input: {
    nickname: Nickname
    identityPublicKey: IdentityPublicKey
    admissionKey: Uint8Array
    challengeId: ChallengeId
    challenge: Challenge
  }): Promise<SessionConfirmation> {
    const proof = await admissionProof(input.admissionKey, this.roomId, input.challengeId, input.challenge)
    const response = await this.request({
      v: PROTOCOL_VERSION,
      type: 'room.join',
      requestId: generateRequestId(),
      roomId: this.roomId,
      payload: {
        nickname: input.nickname,
        identityPublicKey: input.identityPublicKey,
        challengeId: input.challengeId as never,
        proof: proof as never,
      },
    }, ['room.joined'])
    if (response.type !== 'room.joined') throw new Error('Unexpected join response')
    this.resumeState = {
      memberId: response.payload.selfMemberId,
      resumeToken: response.payload.resumeToken,
      identityPublicKey: input.identityPublicKey,
    }
    this.startHeartbeat()
    return response.payload
  }

  async resumeRoom(input: ResumeCredentials): Promise<SessionConfirmation> {
    await this.connect()
    const response = await this.request({
      v: PROTOCOL_VERSION,
      type: 'room.resume',
      requestId: generateRequestId(),
      roomId: this.roomId,
      payload: {
        memberId: input.memberId,
        resumeToken: input.resumeToken as never,
        identityPublicKey: input.identityPublicKey,
      },
    }, ['room.resumed'])
    if (response.type !== 'room.resumed') throw new Error('Unexpected resume response')
    this.resumeState = {
      memberId: response.payload.selfMemberId,
      resumeToken: response.payload.resumeToken,
      identityPublicKey: input.identityPublicKey,
    }
    this.startHeartbeat()
    return response.payload
  }

  sendRtcDescription(targetMemberId: MemberId, description: RTCSessionDescriptionInit): void {
    this.send({
      v: PROTOCOL_VERSION,
      type: 'rtc.description',
      roomId: this.roomId,
      payload: { targetMemberId, description: description as never },
    })
  }

  sendRtcCandidate(targetMemberId: MemberId, candidate: RTCIceCandidateInit): void {
    this.send({
      v: PROTOCOL_VERSION,
      type: 'rtc.candidate',
      roomId: this.roomId,
      payload: { targetMemberId, candidate: candidate as never },
    })
  }

  destroyRoom(): void {
    this.send({ v: PROTOCOL_VERSION, type: 'room.destroy', roomId: this.roomId, payload: {} })
  }

  leave(): void {
    try {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.send({ v: PROTOCOL_VERSION, type: 'room.leave', roomId: this.roomId, payload: {} })
      }
    } catch {
      // Leaving is best-effort; closing the socket still releases the server lease.
    } finally {
      this.close()
    }
  }

  close(): void {
    this.closed = true
    this.stopHeartbeat()
    this.clearDeferredRtcFrames()
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.reconnectStartedAt = undefined
    this.resumeState = undefined
    this.socket?.close(1000, 'client closed')
    this.socket = undefined
  }

  private send(frame: ClientSignalEnvelope): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Signaling connection is not open')
    this.socket.send(JSON.stringify(frame))
  }

  private request(frame: ClientSignalEnvelope, expected: ServerSignalType[]): Promise<ServerSignalEnvelope> {
    if (!frame.requestId) throw new Error('Request ID is required')
    const requestId = frame.requestId
    return new Promise<ServerSignalEnvelope>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('Signaling request timed out'))
      }, 15_000)
      this.pending.set(requestId, { expected: new Set(expected), resolve, reject, timeout })
      try {
        this.send(frame)
      } catch (error) {
        window.clearTimeout(timeout)
        this.pending.delete(requestId)
        reject(error instanceof Error ? error : new Error('Signaling request failed'))
      }
    })
  }

  private handleMessage(raw: unknown): void {
    try {
      if (typeof raw !== 'string') return
      const frame = parseServerSignalEnvelope(JSON.parse(raw) as unknown)
      if (frame.requestId) {
        const request = this.pending.get(frame.requestId)
        if (request && (request.expected.has(frame.type) || frame.type === 'error')) {
          window.clearTimeout(request.timeout)
          this.pending.delete(frame.requestId)
          if (frame.type === 'error') {
            request.reject(new SignalRequestError(frame.payload.code, frame.payload.message, frame.payload.retryAfterMs))
          }
          else request.resolve(frame)
          return
        }
      }
      if (
        (frame.type === 'rtc.description' || frame.type === 'rtc.candidate') &&
        frame.roomId === this.roomId &&
        (this.listeners.size === 0 || this.deferredRtcFrames.length > 0)
      ) {
        this.deferRtcFrame(frame, signalEncoder.encode(raw).byteLength)
        return
      }
      this.notifyListeners(frame)
    } catch {
      // Invalid or oversized frames are ignored; the server cannot force unvalidated state into the client.
    }
  }

  private deferRtcFrame(frame: DeferredRtcFrame['frame'], bytes: number): void {
    if (
      this.deferredRtcFrames.length >= MAX_DEFERRED_RTC_FRAMES ||
      this.deferredRtcBytes + bytes > MAX_DEFERRED_RTC_BYTES
    ) {
      this.failDeferredRtcBuffer()
      return
    }
    this.deferredRtcFrames.push({ frame, bytes })
    this.deferredRtcBytes += bytes
    this.scheduleDeferredRtcFlush()
  }

  private scheduleDeferredRtcFlush(): void {
    if (
      this.deferredRtcFlushScheduled ||
      this.listeners.size === 0 ||
      this.deferredRtcFrames.length === 0
    ) return
    this.deferredRtcFlushScheduled = true
    window.queueMicrotask(() => {
      this.deferredRtcFlushScheduled = false
      if (this.listeners.size === 0) return
      const deferred = this.deferredRtcFrames.splice(0)
      this.deferredRtcBytes = 0
      for (const { frame } of deferred) this.notifyListeners(frame)
    })
  }

  private failDeferredRtcBuffer(): void {
    const error = new Error('Too many RTC signals arrived before connection initialization')
    this.clearDeferredRtcFrames()
    this.closed = true
    this.stopHeartbeat()
    this.resumeState = undefined
    for (const request of this.pending.values()) {
      window.clearTimeout(request.timeout)
      request.reject(error)
    }
    this.pending.clear()
    this.socket?.close(1009, 'deferred RTC signaling overflow')
  }

  private clearDeferredRtcFrames(): void {
    this.deferredRtcFrames.length = 0
    this.deferredRtcBytes = 0
  }

  private notifyListeners(frame: ServerSignalEnvelope): void {
    for (const listener of this.listeners) listener(frame)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.closed && this.socket?.readyState === WebSocket.OPEN) {
        this.send({ v: PROTOCOL_VERSION, type: 'heartbeat', roomId: this.roomId, payload: { sentAt: Date.now() } })
      }
    }, 15_000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) window.clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  private scheduleReconnect(): void {
    if (!this.resumeState || this.closed || this.reconnectTimer !== undefined) return
    this.reconnectStartedAt ??= Date.now()
    if (Date.now() - this.reconnectStartedAt >= this.reconnectWindowMs) {
      this.expireReconnect()
      return
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined
      void this.reconnect()
    }, 1_000)
  }

  private async reconnect(): Promise<void> {
    const resume = this.resumeState
    if (!resume || this.closed) return
    try {
      await this.connect()
      const response = await this.request({
        v: PROTOCOL_VERSION,
        type: 'room.resume',
        requestId: generateRequestId(),
        roomId: this.roomId,
        payload: {
          memberId: resume.memberId,
          resumeToken: resume.resumeToken as never,
          identityPublicKey: resume.identityPublicKey,
        },
      }, ['room.resumed'])
      if (response.type !== 'room.resumed') throw new Error('Unexpected resume response')
      this.resumeState = {
        ...resume,
        memberId: response.payload.selfMemberId,
        resumeToken: response.payload.resumeToken,
      }
      this.reconnectStartedAt = undefined
      this.startHeartbeat()
      this.notifyListeners(response)
    } catch {
      this.socket?.close()
      this.scheduleReconnect()
    }
  }

  private expireReconnect(): void {
    if (this.closed) return
    this.closed = true
    this.stopHeartbeat()
    this.clearDeferredRtcFrames()
    this.resumeState = undefined
    this.reconnectStartedAt = undefined
    this.socket?.close()
    this.socket = undefined
    const frame: ServerSignalEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'error',
      roomId: this.roomId,
      payload: {
        code: 'resume_rejected',
        message: 'The secure connection could not be restored.',
      },
    }
    this.notifyListeners(frame)
  }
}

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import helmet from '@fastify/helmet'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import {
  ClientSignalEnvelopeSchema,
  PROTOCOL_VERSION,
  ServerSignalEnvelopeSchema,
  type ClientSignalEnvelope,
  type SignalErrorCode,
} from '@veilink/protocol'
import Fastify, { LogController, type FastifyInstance } from 'fastify'

import { AdmissionError, AdmissionService } from './admission.js'
import { getPublicConfig, loadConfig, type ServerConfig } from './config.js'
import { isRtcCandidateAllowed, isRtcDescriptionAllowed } from './rtc-policy.js'
import {
  RoomStore,
  RoomStoreError,
  type RoomStoreEvent,
  type RoomSession,
} from './room-store.js'
import { decodeKey, randomId, sanitizePublicIp } from './security.js'
import { createTurnCredential } from './turn.js'

interface SocketLike {
  readyState: number
  send(data: string): void
  ping(): void
  close(code?: number, reason?: string): void
  terminate(): void
  on(event: 'message', listener: (data: { toString(): string }, isBinary: boolean) => void): void
  on(event: 'pong' | 'close' | 'error', listener: () => void): void
}

interface Connection {
  id: string
  socket: SocketLike
  alive: boolean
  malformedMessages: number
  publicIp: string
  queue: Promise<void>
  registered: boolean
  closed: boolean
  binding?: {
    roomId: string
    memberId: string
    sessionId: string
    snapshotVersion: number
  }
}

export interface AppContext {
  app: FastifyInstance
  roomStore: RoomStore
  config: ServerConfig
}

export interface BuildAppOptions {
  config?: ServerConfig
}

class ActionError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'ActionError'
  }
}

function withRequestId<T extends object>(
  event: T,
  requestId?: string,
): T & { requestId?: string } {
  return {
    ...event,
    ...(requestId === undefined ? {} : { requestId }),
  }
}

function send(connection: Connection, event: unknown): void {
  if (connection.socket.readyState !== 1) return
  try {
    const parsed = ServerSignalEnvelopeSchema.safeParse(event)
    const safeEvent = parsed.success
      ? parsed.data
      : {
          v: PROTOCOL_VERSION,
          type: 'error',
          payload: {
            code: 'internal_error',
            message: 'The server could not produce a valid response.',
          },
        }
    connection.socket.send(JSON.stringify(safeEvent))
  } catch {
    // The close/error handlers detach the in-memory session.
  }
}

function originAllowed(origin: string | undefined, config: ServerConfig): boolean {
  return config.appOrigin === undefined || origin === config.appOrigin
}

function assertUnbound(connection: Connection): void {
  if (connection.binding !== undefined) throw new ActionError('already_in_room')
}

function assertBound(connection: Connection, roomId: string): NonNullable<Connection['binding']> {
  const binding = connection.binding
  if (binding === undefined || binding.roomId !== roomId) throw new ActionError('not_in_room')
  return binding
}

function mapSignalError(error: unknown): SignalErrorCode {
  if (error instanceof AdmissionError) {
    return {
      room_not_found: 'room_not_found',
      rate_limited: 'rate_limited',
      challenge_rejected: 'challenge_expired',
      admission_failed: 'bad_proof',
    }[error.code] as SignalErrorCode
  }
  if (error instanceof RoomStoreError) {
    return {
      room_exists: 'room_exists',
      room_not_found: 'room_not_found',
      room_capacity_reached: 'room_full',
      server_capacity_reached: 'room_full',
      already_in_room: 'forbidden',
      member_not_found: 'member_not_found',
      resume_rejected: 'resume_rejected',
      not_owner: 'forbidden',
      target_not_found: 'member_not_found',
      rate_limited: 'rate_limited',
      challenge_rejected: 'challenge_expired',
      admission_failed: 'bad_proof',
    }[error.code] as SignalErrorCode
  }
  if (error instanceof ActionError) {
    if (error.code === 'room_create_rate_limited' || error.code === 'room_ip_capacity_reached') {
      return 'rate_limited'
    }
    if (error.code.startsWith('rtc_')) return 'invalid_signal'
    if (error.code === 'session_expired') return 'member_not_found'
    if (error.code === 'not_in_room' || error.code === 'already_in_room') return 'forbidden'
    return 'invalid_request'
  }
  return 'internal_error'
}

function signalErrorMessage(code: SignalErrorCode): string {
  return {
    invalid_request: 'The request is invalid.',
    unsupported_version: 'The protocol version is unsupported.',
    room_not_found: 'The invitation is unavailable.',
    room_exists: 'Creation could not be completed. Please retry.',
    room_full: 'The participant limit has been reached.',
    room_expired: 'The invitation has expired.',
    challenge_expired: 'The admission challenge is invalid or expired.',
    bad_proof: 'Admission verification failed.',
    rate_limited: 'Too many admission attempts.',
    resume_rejected: 'The secure connection cannot be restored.',
    forbidden: 'This action is not permitted.',
    member_not_found: 'The participant is unavailable.',
    invalid_signal: 'The WebRTC signal violates the active transport policy.',
    internal_error: 'The server could not process the request.',
  }[code]
}

function sendSignalError(
  connection: Connection,
  code: SignalErrorCode,
  options: { requestId?: string; roomId?: string; retryAfterMs?: number } = {},
): void {
  send(connection, {
    v: PROTOCOL_VERSION,
    type: 'error',
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    ...(options.roomId === undefined ? {} : { roomId: options.roomId }),
    payload: {
      code,
      message: signalErrorMessage(code),
      ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    },
  })
}

export async function buildApp(options: BuildAppOptions = {}): Promise<AppContext> {
  const config = options.config ?? loadConfig()
  const tls = config.tlsCertFile && config.tlsKeyFile
    ? {
        cert: readFileSync(config.tlsCertFile),
        key: readFileSync(config.tlsKeyFile),
      }
    : undefined
  const app = Fastify({
    logger: false,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: config.trustProxy,
    bodyLimit: 16 * 1_024,
    requestTimeout: 15_000,
    connectionTimeout: 15_000,
    maxRequestsPerSocket: 1_000,
    ...(tls ? { https: tls } : {}),
  })
  const roomStore = new RoomStore({
    redisUrl: config.redisUrl,
    redisKeyPrefix: config.redisKeyPrefix,
    roomTtlMs: config.roomTtlMs,
    maxRooms: config.maxRooms,
    maxMembers: config.maxMembers,
    maxRoomsPerIp: config.maxRoomsPerIp,
    roomCreateAttemptsPerMinute: config.roomCreateAttemptsPerMinute,
    maxConnections: config.maxConnections,
    maxConnectionsPerIp: config.maxConnectionsPerIp,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    disconnectGraceMs: config.disconnectGraceMs,
    challengeTtlMs: config.challengeTtlMs,
    ipHashSecret: config.turnRestSecret,
  })
  await roomStore.connect()
  const admission = new AdmissionService({ roomStore })
  const connections = new Map<string, Connection>()

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        childSrc: ["'none'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
        frameSrc: ["'none'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        manifestSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        // libsodium's Argon2id/secretstream implementation compiles its bundled
        // WebAssembly module in the browser. This token permits WASM compilation
        // without enabling JavaScript eval or inline scripts.
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
  })

  app.addHook('onRequest', async (request, reply) => {
    const guarded = request.url === '/signal' || request.url.startsWith('/api/')
    const originRequired = request.url === '/signal' && config.appOrigin !== undefined
    if (
      guarded &&
      ((request.headers.origin !== undefined && !originAllowed(request.headers.origin, config)) ||
        (originRequired && request.headers.origin === undefined))
    ) {
      await reply.code(403).send({ error: 'forbidden_origin' })
    }
  })

  app.addHook('onSend', async (_request, reply, payload) => {
    void reply
      .header('Cache-Control', 'no-store, max-age=0')
      .header('Pragma', 'no-cache')
      .header('Expires', '0')
      .header(
        'Permissions-Policy',
        'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
      )
      .header('X-Robots-Tag', 'noindex, nofollow, noarchive')
    return payload
  })

  app.setErrorHandler(async (_error, _request, reply) => {
    if (!reply.sent) await reply.code(500).send({ error: 'internal_error' })
  })

  app.get('/healthz', async (_request, reply) => {
    if (!await roomStore.isHealthy()) return reply.code(503).send({ status: 'unavailable' as const })
    return { status: 'ok' as const }
  })
  app.get('/api/config', async () => getPublicConfig(config))

  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: 128 * 1_024,
      perMessageDeflate: false,
    },
  })

  const issueTurnCredentials = (
    connection: Connection,
    roomId: string,
    memberId: string,
    requestId?: string,
  ): void => {
    const credential = createTurnCredential({
      memberId,
      urls: config.turnUrls,
      sharedSecret: config.turnRestSecret,
      ttlSeconds: config.turnCredentialTtlSeconds,
    })
    send(
      connection,
      withRequestId(
        {
          v: PROTOCOL_VERSION,
          type: 'turn.credentials',
          roomId,
          payload: credential,
        },
        requestId,
      ),
    )
  }

  const bindSession = (
    connection: Connection,
    roomId: string,
    session: RoomSession,
    type: 'room.created' | 'room.joined' | 'room.resumed',
    requestId?: string,
  ): void => {
    connection.binding = {
      roomId,
      memberId: session.memberId,
      sessionId: session.sessionId,
      snapshotVersion: session.snapshot.snapshotVersion,
    }
    send(
      connection,
      withRequestId(
        {
          v: PROTOCOL_VERSION,
          type,
          roomId,
          payload: {
            selfMemberId: session.memberId,
            resumeToken: session.resumeToken,
            snapshot: session.snapshot,
          },
        },
        requestId,
      ),
    )
  }

  const handleMessage = async (connection: Connection, message: ClientSignalEnvelope): Promise<void> => {
    if (connection.closed || !connection.registered) throw new ActionError('session_expired')
    const requestId = message.requestId
    const roomId = message.roomId

    switch (message.type) {
      case 'room.create': {
        assertUnbound(connection)
        if (!await roomStore.consumeRoomCreateAttempt(connection.publicIp)) {
          throw new ActionError('room_create_rate_limited')
        }
        const admissionKey = decodeKey(message.payload.admissionVerifier)
        if (admissionKey === undefined) throw new ActionError('invalid_admission_verifier')
        try {
          const session = await roomStore.createRoom({
            roomId,
            admissionKey,
            nickname: message.payload.nickname,
            identityPublicKey: message.payload.identityPublicKey,
            transportId: connection.id,
            publicIp: connection.publicIp,
          })
          bindSession(connection, roomId, session, 'room.created', requestId)
        } finally {
          admissionKey.fill(0)
        }
        break
      }

      case 'room.challenge': {
        assertUnbound(connection)
        const challenge = await admission.issue(
          roomId,
          connection.id,
          connection.publicIp,
          message.payload.nickname,
          message.payload.identityPublicKey,
        )
        send(
          connection,
          withRequestId(
            {
              v: PROTOCOL_VERSION,
              type: 'room.challenge',
              roomId,
              payload: {
                challengeId: challenge.challengeId,
                challenge: challenge.nonce,
                expiresAt: challenge.expiresAt,
              },
            },
            requestId,
          ),
        )
        break
      }

      case 'room.join': {
        assertUnbound(connection)
        await admission.verify({
          roomId,
          challengeId: message.payload.challengeId,
          proof: message.payload.proof,
          transportId: connection.id,
          publicIp: connection.publicIp,
          nickname: message.payload.nickname,
          identityPublicKey: message.payload.identityPublicKey,
        })
        const session = await roomStore.joinRoom({
          roomId,
          nickname: message.payload.nickname,
          identityPublicKey: message.payload.identityPublicKey,
          transportId: connection.id,
        })
        bindSession(connection, roomId, session, 'room.joined', requestId)
        break
      }

      case 'room.resume': {
        assertUnbound(connection)
        const session = await roomStore.resumeRoom({
          roomId,
          memberId: message.payload.memberId,
          resumeToken: message.payload.resumeToken,
          identityPublicKey: message.payload.identityPublicKey,
          transportId: connection.id,
        })
        bindSession(connection, roomId, session, 'room.resumed', requestId)
        break
      }

      case 'room.leave': {
        const binding = assertBound(connection, roomId)
        await roomStore.leave(roomId, binding.memberId, binding.sessionId)
        delete connection.binding
        connection.socket.close(1_000, 'left room')
        break
      }

      case 'room.destroy': {
        const binding = assertBound(connection, roomId)
        await roomStore.destroyByOwner(roomId, binding.memberId, binding.sessionId)
        break
      }

      case 'rtc.description': {
        const binding = assertBound(connection, roomId)
        if (!isRtcDescriptionAllowed(message.payload.description.sdp ?? '')) {
          throw new ActionError('rtc_transport_policy_violation')
        }
        await roomStore.forwardRtcEvent({
          roomId,
          senderId: binding.memberId,
          sessionId: binding.sessionId,
          targetMemberId: message.payload.targetMemberId,
          type: 'rtc.description',
          data: message.payload.description,
        })
        break
      }

      case 'rtc.candidate': {
        const binding = assertBound(connection, roomId)
        if (!isRtcCandidateAllowed(message.payload.candidate.candidate)) {
          throw new ActionError('rtc_transport_policy_violation')
        }
        await roomStore.forwardRtcEvent({
          roomId,
          senderId: binding.memberId,
          sessionId: binding.sessionId,
          targetMemberId: message.payload.targetMemberId,
          type: 'rtc.candidate',
          data: message.payload.candidate,
        })
        break
      }

      case 'turn.credentials.refresh': {
        const binding = assertBound(connection, roomId)
        if (!await roomStore.authorize(roomId, binding.memberId, binding.sessionId)) {
          throw new ActionError('session_expired')
        }
        issueTurnCredentials(connection, roomId, binding.memberId, requestId)
        break
      }

      case 'heartbeat': {
        const binding = assertBound(connection, roomId)
        const latestSnapshot = await roomStore.touch(roomId, binding.memberId, binding.sessionId)
        if (latestSnapshot === undefined) {
          throw new ActionError('session_expired')
        }
        if (latestSnapshot.snapshotVersion !== binding.snapshotVersion) {
          binding.snapshotVersion = latestSnapshot.snapshotVersion
          send(connection, {
            v: PROTOCOL_VERSION,
            type: 'room.snapshot',
            roomId,
            payload: latestSnapshot,
          })
        }
        connection.alive = true
        send(
          connection,
          withRequestId(
            {
              v: PROTOCOL_VERSION,
              type: 'heartbeat.ack',
              roomId,
              payload: { sentAt: message.payload.sentAt, serverNow: Date.now() },
            },
            requestId,
          ),
        )
        break
      }
    }
  }

  const handleStoreEvent = (event: RoomStoreEvent): void => {
    if (event.kind === 'session-replaced') {
      const connection = connections.get(event.sessionId)
      if (connection?.binding?.roomId === event.roomId && connection.binding.memberId === event.memberId) {
        delete connection.binding
        connection.socket.close(1_008, 'session replaced')
      }
      return
    }
    for (const connection of connections.values()) {
      const binding = connection.binding
      if (binding?.roomId !== event.roomId) continue
      if (event.excludedMemberId === binding.memberId) continue
      if (event.targetMemberId !== undefined && event.targetMemberId !== binding.memberId) continue
      if (event.targetSessionId !== undefined && event.targetSessionId !== binding.sessionId) continue
      send(connection, { ...event.event, roomId: event.roomId })
      const payload = event.event.payload
      if (typeof payload === 'object' && payload !== null && 'snapshotVersion' in payload) {
        const version = (payload as { snapshotVersion?: unknown }).snapshotVersion
        if (typeof version === 'number') binding.snapshotVersion = Math.max(binding.snapshotVersion, version)
      }
      if (event.event.type === 'room.ended') delete connection.binding
    }
  }
  const removeStoreEventListener = roomStore.onEvent(handleStoreEvent)

  app.get('/signal', { websocket: true }, (socket, request) => {
    if (!originAllowed(request.headers.origin, config)) {
      socket.close(1_008, 'forbidden origin')
      return
    }
    const publicIp = sanitizePublicIp(request.ip)
    const connection: Connection = {
      id: randomId(16),
      socket: socket as SocketLike,
      alive: true,
      malformedMessages: 0,
      publicIp,
      queue: Promise.resolve(),
      registered: false,
      closed: false,
    }
    connections.set(connection.id, connection)
    connection.queue = roomStore.registerConnection(connection.id, publicIp)
      .then((registered) => {
        if (!registered) {
          connection.closed = true
          connection.socket.close(1_013, 'connection capacity reached')
          return
        }
        connection.registered = true
      })
      .catch(() => {
        connection.closed = true
        connection.socket.close(1_013, 'state unavailable')
      })

    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        connection.malformedMessages += 1
        sendSignalError(connection, 'invalid_request')
        if (connection.malformedMessages >= 3) connection.socket.close(1_008, 'invalid messages')
        return
      }

      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(raw.toString())
      } catch {
        connection.malformedMessages += 1
        sendSignalError(connection, 'invalid_request')
        if (connection.malformedMessages >= 3) connection.socket.close(1_008, 'invalid messages')
        return
      }

      const parsed = ClientSignalEnvelopeSchema.safeParse(parsedJson)
      if (!parsed.success) {
        connection.malformedMessages += 1
        const unsupportedVersion =
          typeof parsedJson === 'object' &&
          parsedJson !== null &&
          'v' in parsedJson &&
          parsedJson.v !== PROTOCOL_VERSION
        sendSignalError(connection, unsupportedVersion ? 'unsupported_version' : 'invalid_request')
        if (connection.malformedMessages >= 3) connection.socket.close(1_008, 'invalid messages')
        return
      }

      connection.queue = connection.queue
        .then(() => handleMessage(connection, parsed.data))
        .catch((error: unknown) => {
          if (connection.closed) return
          const code = mapSignalError(error)
          sendSignalError(connection, code, {
            ...(parsed.data.requestId === undefined ? {} : { requestId: parsed.data.requestId }),
            roomId: parsed.data.roomId,
            ...(code === 'rate_limited' ? { retryAfterMs: 10 * 60 * 1_000 } : {}),
          })
          if (!(error instanceof ActionError)) connection.socket.close(1_013, 'state unavailable')
        })
    })

    socket.on('pong', () => {
      connection.alive = true
      const binding = connection.binding
      const refreshes: Array<Promise<unknown>> = [roomStore.refreshConnection(connection.id, connection.publicIp)]
      if (binding !== undefined) refreshes.push(roomStore.touch(binding.roomId, binding.memberId, binding.sessionId))
      void Promise.all(refreshes).catch(() => connection.socket.close(1_013, 'state unavailable'))
    })

    socket.on('close', () => {
      connection.closed = true
      connections.delete(connection.id)
      const binding = connection.binding
      if (binding !== undefined) {
        void roomStore.disconnect(binding.roomId, binding.memberId, binding.sessionId).catch(() => undefined)
      }
      if (connection.registered) {
        void roomStore.removeConnection(connection.id, connection.publicIp).catch(() => undefined)
      }
      delete connection.binding
    })

    socket.on('error', () => {
      // Never log socket metadata. The close event performs cleanup.
    })
  })

  const heartbeatTimer = setInterval(() => {
    for (const connection of connections.values()) {
      if (!connection.alive) {
        connection.socket.terminate()
        continue
      }
      connection.alive = false
      try {
        connection.socket.ping()
      } catch {
        connection.socket.terminate()
      }
    }
  }, config.heartbeatIntervalMs)
  heartbeatTimer.unref()

  let sweepRunning = false
  const sweepTimer = setInterval(() => {
    if (sweepRunning) return
    sweepRunning = true
    void roomStore.sweep()
      .catch(() => undefined)
      .finally(() => { sweepRunning = false })
  }, 1_000)
  sweepTimer.unref()

  const indexPath = join(config.staticRoot, 'index.html')
  const staticAvailable = existsSync(indexPath)
  if (staticAvailable) {
    await app.register(fastifyStatic, {
      root: config.staticRoot,
      prefix: '/',
      wildcard: false,
      cacheControl: false,
      etag: false,
      lastModified: false,
      setHeaders(response) {
        response.setHeader('Cache-Control', 'no-store, max-age=0')
      },
    })
  }

  app.setNotFoundHandler(async (request, reply) => {
    const acceptsHtml = request.headers.accept?.includes('text/html') === true
    const isSpaRoute =
      request.method === 'GET' &&
      acceptsHtml &&
      !request.url.startsWith('/api/') &&
      request.url !== '/signal'
    if (staticAvailable && isSpaRoute) return reply.sendFile('index.html')
    return reply.code(404).send({ error: 'not_found' })
  })

  app.addHook('onClose', async () => {
    clearInterval(heartbeatTimer)
    clearInterval(sweepTimer)
    removeStoreEventListener()
    const activeConnections = [...connections.values()]
    await Promise.all(activeConnections.map(async (connection) => {
      const binding = connection.binding
      if (binding !== undefined) {
        await roomStore.disconnect(binding.roomId, binding.memberId, binding.sessionId)
      }
      if (connection.registered) await roomStore.removeConnection(connection.id, connection.publicIp)
    }))
    for (const connection of activeConnections) connection.socket.close(1_001, 'server shutdown')
    connections.clear()
    await roomStore.close()
  })

  return { app, roomStore, config }
}

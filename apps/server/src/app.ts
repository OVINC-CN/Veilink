import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import helmet from '@fastify/helmet'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import {
  ClientSignalEnvelopeSchema,
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
  type RoomSession,
  type WireEvent,
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
  binding?: {
    roomId: string
    memberId: string
  }
}

export interface AppContext {
  app: FastifyInstance
  roomStore: RoomStore
  config: ServerConfig
}

export interface BuildAppOptions {
  config?: ServerConfig
  roomStore?: RoomStore
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
          v: 1,
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

function assertBound(connection: Connection, roomId: string): { roomId: string; memberId: string } {
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
      mode_switching: 'mode_conflict',
      already_in_room: 'forbidden',
      member_not_found: 'member_not_found',
      resume_rejected: 'resume_rejected',
      not_owner: 'forbidden',
      invalid_mode: 'mode_conflict',
      invalid_mode_version: 'mode_conflict',
      target_not_found: 'member_not_found',
    }[error.code] as SignalErrorCode
  }
  if (error instanceof ActionError) {
    if (error.code === 'room_create_rate_limited' || error.code === 'room_ip_capacity_reached') {
      return 'rate_limited'
    }
    if (error.code.startsWith('rtc_')) return 'invalid_signal'
    if (error.code === 'session_expired') return 'member_not_found'
    if (error.code === 'turn_unavailable' || error.code === 'turn_not_active') return 'mode_conflict'
    if (error.code === 'not_in_room' || error.code === 'already_in_room') return 'forbidden'
    return 'invalid_request'
  }
  return 'internal_error'
}

function signalErrorMessage(code: SignalErrorCode): string {
  return {
    invalid_request: 'The request is invalid.',
    unsupported_version: 'The protocol version is unsupported.',
    room_not_found: 'The room does not exist.',
    room_exists: 'The room already exists.',
    room_full: 'The room is full.',
    room_expired: 'The room has expired.',
    challenge_expired: 'The admission challenge is invalid or expired.',
    bad_proof: 'Admission verification failed.',
    rate_limited: 'Too many admission attempts.',
    resume_rejected: 'The in-memory session cannot be resumed.',
    forbidden: 'This action is not permitted.',
    mode_conflict: 'The room mode changed or is currently changing.',
    mode_timeout: 'The room mode switch timed out.',
    member_not_found: 'The room member is unavailable.',
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
    v: 1,
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
  const roomStore =
    options.roomStore ??
    new RoomStore({
      roomTtlMs: config.roomTtlMs,
      maxRooms: config.maxRooms,
      maxMembers: config.maxMembers,
      disconnectGraceMs: config.disconnectGraceMs,
      modeSwitchTimeoutMs: config.modeSwitchTimeoutMs,
    })
  const admission = new AdmissionService({
    roomStore,
    challengeTtlMs: config.challengeTtlMs,
  })
  const roomCreatorIp = new Map<string, string>()
  const roomsByCreatorIp = new Map<string, Set<string>>()
  const createRateWindows = new Map<string, { startedAt: number; attempts: number }>()
  const removeRoomDestroyListener = roomStore.onDestroyed((roomId) => {
    admission.clearRoom(roomId)
    const publicIp = roomCreatorIp.get(roomId)
    if (publicIp !== undefined) {
      roomCreatorIp.delete(roomId)
      const rooms = roomsByCreatorIp.get(publicIp)
      rooms?.delete(roomId)
      if (rooms?.size === 0) roomsByCreatorIp.delete(publicIp)
    }
  })
  const connections = new Map<string, Connection>()

  const consumeRoomCreateAttempt = (publicIp: string): boolean => {
    const now = Date.now()
    let window = createRateWindows.get(publicIp)
    if (!window || now - window.startedAt >= 60_000) {
      window = { startedAt: now, attempts: 0 }
      createRateWindows.set(publicIp, window)
    }
    if (window.attempts >= config.roomCreateAttemptsPerMinute) return false
    window.attempts += 1
    return true
  }

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

  app.get('/healthz', async () => ({ status: 'ok' as const }))
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
    if (config.turnRestSecret === undefined) throw new ActionError('turn_unavailable')
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
          v: 1,
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
    connection.binding = { roomId, memberId: session.memberId }
    send(
      connection,
      withRequestId(
        {
          v: 1,
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
    if (session.snapshot.mode === 'turn') {
      issueTurnCredentials(connection, roomId, session.memberId)
    }
  }

  const sinkFor = (connection: Connection, roomId: string) => (event: WireEvent): void => {
    send(connection, { ...event, roomId })
    if (event.type === 'room.mode.pending') {
      const payload = event.payload as { mode?: string }
      const memberId = connection.binding?.memberId
      if (payload.mode === 'turn' && memberId !== undefined) {
        try {
          issueTurnCredentials(connection, roomId, memberId)
        } catch {
          send(connection, {
            v: 1,
            type: 'error',
            roomId,
            payload: {
              code: 'mode_conflict',
              message: 'TURN relay is unavailable.',
            },
          })
        }
      }
    }
    if (event.type === 'room.ended') delete connection.binding
    if (
      event.type === 'error' &&
      (event.payload as { code?: string }).code === 'mode_timeout'
    ) {
      delete connection.binding
      connection.socket.close(4001, 'mode switch timeout')
    }
  }

  const handleMessage = (connection: Connection, message: ClientSignalEnvelope): void => {
    const requestId = message.requestId
    const roomId = message.roomId

    switch (message.type) {
      case 'room.create': {
        assertUnbound(connection)
        if (!consumeRoomCreateAttempt(connection.publicIp)) {
          throw new ActionError('room_create_rate_limited')
        }
        if ((roomsByCreatorIp.get(connection.publicIp)?.size ?? 0) >= config.maxRoomsPerIp) {
          throw new ActionError('room_ip_capacity_reached')
        }
        if (message.payload.mode === 'turn' && config.turnRestSecret === undefined) {
          throw new ActionError('turn_unavailable')
        }
        const admissionKey = decodeKey(message.payload.admissionVerifier)
        if (admissionKey === undefined) throw new ActionError('invalid_admission_verifier')
        try {
          const session = roomStore.createRoom({
            roomId,
            admissionKey,
            mode: message.payload.mode,
            nickname: message.payload.nickname,
            identityPublicKey: message.payload.identityPublicKey,
            publicIp: connection.publicIp,
            transportId: connection.id,
            sink: sinkFor(connection, roomId),
          })
          roomCreatorIp.set(roomId, connection.publicIp)
          const rooms = roomsByCreatorIp.get(connection.publicIp) ?? new Set<string>()
          rooms.add(roomId)
          roomsByCreatorIp.set(connection.publicIp, rooms)
          bindSession(connection, roomId, session, 'room.created', requestId)
        } finally {
          admissionKey.fill(0)
        }
        break
      }

      case 'room.challenge': {
        assertUnbound(connection)
        const challenge = admission.issue(
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
              v: 1,
              type: 'room.challenge',
              roomId,
              payload: {
                challengeId: challenge.challengeId,
                challenge: challenge.nonce,
                mode: roomStore.getRoomMode(roomId)?.mode ?? 'turn',
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
        admission.verify({
          roomId,
          challengeId: message.payload.challengeId,
          proof: message.payload.proof,
          transportId: connection.id,
          publicIp: connection.publicIp,
          nickname: message.payload.nickname,
          identityPublicKey: message.payload.identityPublicKey,
        })
        const session = roomStore.joinRoom({
          roomId,
          nickname: message.payload.nickname,
          identityPublicKey: message.payload.identityPublicKey,
          publicIp: connection.publicIp,
          transportId: connection.id,
          sink: sinkFor(connection, roomId),
        })
        bindSession(connection, roomId, session, 'room.joined', requestId)
        break
      }

      case 'room.resume': {
        assertUnbound(connection)
        const session = roomStore.resumeRoom({
          roomId,
          memberId: message.payload.memberId,
          resumeToken: message.payload.resumeToken,
          identityPublicKey: message.payload.identityPublicKey,
          publicIp: connection.publicIp,
          transportId: connection.id,
          sink: sinkFor(connection, roomId),
        })
        bindSession(connection, roomId, session, 'room.resumed', requestId)
        break
      }

      case 'room.leave': {
        const binding = assertBound(connection, roomId)
        roomStore.leave(roomId, binding.memberId, connection.id)
        delete connection.binding
        connection.socket.close(1_000, 'left room')
        break
      }

      case 'room.destroy': {
        const binding = assertBound(connection, roomId)
        roomStore.destroyByOwner(roomId, binding.memberId, connection.id)
        break
      }

      case 'room.mode.request': {
        const binding = assertBound(connection, roomId)
        if (message.payload.mode === 'turn' && config.turnRestSecret === undefined) {
          throw new ActionError('turn_unavailable')
        }
        roomStore.requestModeSwitch(
          roomId,
          binding.memberId,
          connection.id,
          message.payload.mode,
          message.payload.expectedVersion,
        )
        break
      }

      case 'room.mode.ack': {
        const binding = assertBound(connection, roomId)
        roomStore.acknowledgeModeSwitch(
          roomId,
          binding.memberId,
          connection.id,
          message.payload.version,
          message.payload.status,
        )
        if (message.payload.status === 'failed') {
          delete connection.binding
          connection.socket.close(4_001, 'mode switch failed')
        }
        break
      }

      case 'rtc.description': {
        const binding = assertBound(connection, roomId)
        const roomMode = roomStore.getRoomMode(roomId)
        if (
          roomMode === undefined ||
          !isRtcDescriptionAllowed(message.payload.description.sdp ?? '', roomMode.mode)
        ) {
          throw new ActionError('rtc_transport_policy_violation')
        }
        roomStore.forwardRtcDescription({
          roomId,
          senderId: binding.memberId,
          transportId: connection.id,
          targetMemberId: message.payload.targetMemberId,
          modeVersion: message.payload.modeVersion,
          generation: message.payload.generation,
          description: message.payload.description,
        })
        break
      }

      case 'rtc.candidate': {
        const binding = assertBound(connection, roomId)
        const roomMode = roomStore.getRoomMode(roomId)
        if (
          roomMode === undefined ||
          !isRtcCandidateAllowed(message.payload.candidate.candidate, roomMode.mode)
        ) {
          throw new ActionError('rtc_transport_policy_violation')
        }
        roomStore.forwardRtcCandidate({
          roomId,
          senderId: binding.memberId,
          transportId: connection.id,
          targetMemberId: message.payload.targetMemberId,
          modeVersion: message.payload.modeVersion,
          generation: message.payload.generation,
          candidate: message.payload.candidate,
        })
        break
      }

      case 'turn.credentials.refresh': {
        const binding = assertBound(connection, roomId)
        if (!roomStore.canIssueTurnCredentials(roomId)) {
          throw new ActionError('turn_not_active')
        }
        issueTurnCredentials(connection, roomId, binding.memberId, requestId)
        break
      }

      case 'heartbeat': {
        const binding = assertBound(connection, roomId)
        if (!roomStore.touch(roomId, binding.memberId, connection.id)) {
          throw new ActionError('session_expired')
        }
        connection.alive = true
        send(
          connection,
          withRequestId(
            {
              v: 1,
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

  app.get('/signal', { websocket: true }, (socket, request) => {
    if (!originAllowed(request.headers.origin, config)) {
      socket.close(1_008, 'forbidden origin')
      return
    }
    const publicIp = sanitizePublicIp(request.ip)
    const connectionsForIp = [...connections.values()].reduce(
      (count, connection) => count + Number(connection.publicIp === publicIp),
      0,
    )
    if (connections.size >= config.maxConnections || connectionsForIp >= config.maxConnectionsPerIp) {
      socket.close(1_013, 'connection capacity reached')
      return
    }
    const connection: Connection = {
      id: randomId(16),
      socket: socket as SocketLike,
      alive: true,
      malformedMessages: 0,
      publicIp,
    }
    connections.set(connection.id, connection)

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
          parsedJson.v !== 1
        sendSignalError(connection, unsupportedVersion ? 'unsupported_version' : 'invalid_request')
        if (connection.malformedMessages >= 3) connection.socket.close(1_008, 'invalid messages')
        return
      }

      try {
        handleMessage(connection, parsed.data)
      } catch (error) {
        const code = mapSignalError(error)
        sendSignalError(connection, code, {
          ...(parsed.data.requestId === undefined ? {} : { requestId: parsed.data.requestId }),
          roomId: parsed.data.roomId,
          ...(code === 'rate_limited' ? { retryAfterMs: 10 * 60 * 1_000 } : {}),
        })
      }
    })

    socket.on('pong', () => {
      connection.alive = true
      const binding = connection.binding
      if (binding !== undefined) roomStore.touch(binding.roomId, binding.memberId, connection.id)
    })

    socket.on('close', () => {
      connections.delete(connection.id)
      admission.removeForTransport(connection.id)
      const binding = connection.binding
      if (binding !== undefined) roomStore.disconnect(binding.roomId, binding.memberId, connection.id)
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

  const sweepTimer = setInterval(() => {
    admission.sweep()
    roomStore.sweep()
    const now = Date.now()
    for (const [publicIp, window] of createRateWindows) {
      if (now - window.startedAt >= 60_000) createRateWindows.delete(publicIp)
    }
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
    roomStore.close('server-restarted')
    removeRoomDestroyListener()
    for (const connection of connections.values()) connection.socket.close(1_001, 'server shutdown')
    connections.clear()
    createRateWindows.clear()
    roomCreatorIp.clear()
    roomsByCreatorIp.clear()
  })

  return { app, roomStore, config }
}

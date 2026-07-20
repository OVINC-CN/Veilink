import { createHmac } from 'node:crypto'

import {
  IdentityPublicKeySchema,
  MemberIdSchema,
  NicknameSchema,
  PROTOCOL_VERSION,
  RoomIdSchema,
  type PublicMember,
  type RoomSnapshot,
} from '@veilink/protocol'
import { createClient, type RedisClientType } from 'redis'

import { hashResumeToken, randomId, safeEqual, verifyAdmissionProof } from './security.js'

export interface WireEvent {
  v: typeof PROTOCOL_VERSION
  type: string
  requestId?: string
  payload: unknown
}

export interface RoomSession {
  memberId: string
  sessionId: string
  resumeToken: string
  snapshot: RoomSnapshot
}

export interface StoredChallenge {
  id: string
  nonce: string
  roomId: string
  transportId: string
  publicIpHash: string
  nickname: string
  identityPublicKey: string
  expiresAt: number
}

export interface RoomStoreWireEvent {
  kind: 'wire'
  roomId: string
  event: WireEvent
  excludedMemberId?: string
  targetMemberId?: string
  targetSessionId?: string
}

export interface RoomStoreSessionReplacedEvent {
  kind: 'session-replaced'
  roomId: string
  memberId: string
  sessionId: string
}

export type RoomStoreEvent = RoomStoreWireEvent | RoomStoreSessionReplacedEvent

interface StoredMember {
  id: string
  nickname: string
  identityPublicKey: string
  joinedAt: number
  resumeTokenHash: string
  sessionId: string
}

interface StoredRoom {
  schemaVersion: 1
  id: string
  admissionKey: string
  snapshotVersion: number
  ownerId: string | null
  creatorIpHash: string
  createdAt: number
  expiresAt: number
  members: StoredMember[]
}

interface InternalEventEnvelope {
  v: 1
  events: RoomStoreEvent[]
}

export type RoomStoreErrorCode =
  | 'room_exists'
  | 'room_not_found'
  | 'room_capacity_reached'
  | 'server_capacity_reached'
  | 'already_in_room'
  | 'member_not_found'
  | 'resume_rejected'
  | 'not_owner'
  | 'target_not_found'
  | 'rate_limited'
  | 'challenge_rejected'
  | 'admission_failed'

export class RoomStoreError extends Error {
  constructor(readonly code: RoomStoreErrorCode) {
    super(code)
    this.name = 'RoomStoreError'
  }
}

export interface RoomStoreOptions {
  redisUrl: string
  redisKeyPrefix: string
  roomTtlMs: number
  maxRooms?: number
  maxMembers?: number
  maxRoomsPerIp?: number
  roomCreateAttemptsPerMinute?: number
  maxConnections?: number
  maxConnectionsPerIp?: number
  heartbeatIntervalMs?: number
  disconnectGraceMs?: number
  challengeTtlMs?: number
  ipHashSecret: string
}

const CAS_ROOM_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == '' then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[2], ARGV[4])
  if ARGV[12] == '1' then redis.call('ZREM', KEYS[6], ARGV[4]) end
else
  redis.call('SET', KEYS[1], ARGV[2], 'PXAT', ARGV[3])
  redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
end
if ARGV[6] == 'set' then
  redis.call('SET', KEYS[5], ARGV[7], 'PX', ARGV[8])
  redis.call('ZADD', KEYS[3], ARGV[9], ARGV[10])
elseif ARGV[6] == 'delete' then
  redis.call('DEL', KEYS[5])
  redis.call('ZREM', KEYS[3], ARGV[10])
end
if ARGV[5] ~= '' then redis.call('PUBLISH', KEYS[4], ARGV[5]) end
return 1
`

const CREATE_ROOM_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', ARGV[1])
if redis.call('EXISTS', KEYS[1]) == 1 then return 1 end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[2]) then return 2 end
if redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[3]) then return 3 end
redis.call('SET', KEYS[1], ARGV[4], 'PXAT', ARGV[5])
redis.call('ZADD', KEYS[2], ARGV[5], ARGV[6])
redis.call('ZADD', KEYS[3], ARGV[5], ARGV[6])
redis.call('SET', KEYS[4], ARGV[7], 'PX', ARGV[8])
redis.call('ZADD', KEYS[5], ARGV[9], ARGV[10])
return 0
`

const TOUCH_SESSION_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
redis.call('PEXPIRE', KEYS[2], ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[5])
return 1
`

const DISCONNECT_SESSION_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
return 1
`

const AUTHORIZE_PUBLISH_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return -1 end
if ARGV[3] ~= '' and redis.call('GET', KEYS[3]) ~= ARGV[3] then return -2 end
redis.call('PUBLISH', KEYS[4], ARGV[4])
return 1
`

const CREATE_RATE_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if current > tonumber(ARGV[2]) then return 0 end
return 1
`

const CAN_ADMIT_SCRIPT = `
local pair = tonumber(redis.call('GET', KEYS[1]) or '0')
local room = tonumber(redis.call('GET', KEYS[2]) or '0')
if pair >= tonumber(ARGV[1]) or room >= tonumber(ARGV[2]) then return 0 end
return 1
`

const RECORD_ADMISSION_FAILURE_SCRIPT = `
local pair = redis.call('INCR', KEYS[1])
if pair == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local room = redis.call('INCR', KEYS[2])
if room == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[1]) end
return 1
`

const REGISTER_CONNECTION_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) then return 0 end
redis.call('SET', KEYS[3], ARGV[4], 'PX', ARGV[5])
redis.call('ZADD', KEYS[1], ARGV[6], ARGV[4])
redis.call('ZADD', KEYS[2], ARGV[6], ARGV[4])
return 1
`

const REFRESH_CONNECTION_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
return 1
`

const REMOVE_CONNECTION_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
return 1
`

const CLAIM_EXPIRED_ROOM_SCRIPT = `
local score = redis.call('ZSCORE', KEYS[2], ARGV[1])
if not score or tonumber(score) > tonumber(ARGV[2]) then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('PUBLISH', KEYS[3], ARGV[3])
return 1
`

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid Redis ${name}`)
  return value
}

function requiredInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid Redis ${name}`)
  return value as number
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`Invalid Redis ${name} fields`)
  }
}

function parseMember(value: unknown): StoredMember {
  if (!isPlainObject(value)) throw new Error('Invalid Redis member record')
  assertExactKeys(
    value,
    ['id', 'nickname', 'identityPublicKey', 'joinedAt', 'resumeTokenHash', 'sessionId'],
    'member',
  )
  const resumeTokenHash = requiredString(value.resumeTokenHash, 'resume token hash')
  if (!/^[a-f0-9]{64}$/u.test(resumeTokenHash)) throw new Error('Invalid Redis resume token hash')
  return {
    id: MemberIdSchema.parse(value.id) as string,
    nickname: NicknameSchema.parse(value.nickname) as string,
    identityPublicKey: IdentityPublicKeySchema.parse(value.identityPublicKey) as string,
    joinedAt: requiredInteger(value.joinedAt, 'member joined time'),
    resumeTokenHash,
    sessionId: requiredString(value.sessionId, 'session ID'),
  }
}

function parseRoom(raw: string): StoredRoom {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    throw new Error('Invalid Redis room JSON')
  }
  if (!isPlainObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.members)) {
    throw new Error('Unsupported Redis room record')
  }
  assertExactKeys(
    value,
    ['schemaVersion', 'id', 'admissionKey', 'snapshotVersion', 'ownerId', 'creatorIpHash', 'createdAt', 'expiresAt', 'members'],
    'room',
  )
  if (value.members.length > 8) throw new Error('Invalid Redis member count')
  const members = value.members.map(parseMember)
  if (new Set(members.map((member) => member.id)).size !== members.length) {
    throw new Error('Duplicate Redis member ID')
  }
  const ownerId = value.ownerId === null ? null : MemberIdSchema.parse(value.ownerId) as string
  if (ownerId !== null && !members.some((member) => member.id === ownerId)) {
    throw new Error('Invalid Redis owner')
  }
  const admissionKey = requiredString(value.admissionKey, 'admission key')
  if (Buffer.from(admissionKey, 'base64url').byteLength !== 32) {
    throw new Error('Invalid Redis admission key')
  }
  return {
    schemaVersion: 1,
    id: RoomIdSchema.parse(value.id) as string,
    admissionKey,
    snapshotVersion: requiredInteger(value.snapshotVersion, 'snapshot version'),
    ownerId,
    creatorIpHash: requiredString(value.creatorIpHash, 'creator hash'),
    createdAt: requiredInteger(value.createdAt, 'created time'),
    expiresAt: requiredInteger(value.expiresAt, 'expiry time'),
    members,
  }
}

function parseChallenge(raw: string): StoredChallenge {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    throw new Error('Invalid Redis challenge JSON')
  }
  if (!isPlainObject(value)) throw new Error('Invalid Redis challenge')
  assertExactKeys(
    value,
    ['id', 'nonce', 'roomId', 'transportId', 'publicIpHash', 'nickname', 'identityPublicKey', 'expiresAt'],
    'challenge',
  )
  return {
    id: requiredString(value.id, 'challenge ID'),
    nonce: requiredString(value.nonce, 'challenge nonce'),
    roomId: RoomIdSchema.parse(value.roomId) as string,
    transportId: requiredString(value.transportId, 'challenge transport ID'),
    publicIpHash: requiredString(value.publicIpHash, 'challenge IP hash'),
    nickname: NicknameSchema.parse(value.nickname) as string,
    identityPublicKey: IdentityPublicKeySchema.parse(value.identityPublicKey) as string,
    expiresAt: requiredInteger(value.expiresAt, 'challenge expiry'),
  }
}

function serializeRoom(room: StoredRoom): string {
  return JSON.stringify(room)
}

function publicMember(room: StoredRoom, member: StoredMember): PublicMember {
  return {
    memberId: member.id,
    nickname: member.nickname,
    identityPublicKey: member.identityPublicKey,
    joinedAt: member.joinedAt,
    isOwner: member.id === room.ownerId,
  } as PublicMember
}

function snapshot(room: StoredRoom, serverNow: number): RoomSnapshot {
  if (room.ownerId === null || room.members.length === 0) {
    throw new Error('Cannot snapshot a vacant room')
  }
  return {
    roomId: room.id,
    snapshotVersion: room.snapshotVersion,
    ownerId: room.ownerId,
    members: [...room.members]
      .sort((left, right) => left.joinedAt - right.joinedAt || left.id.localeCompare(right.id))
      .map((member) => publicMember(room, member)),
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    serverNow,
  } as RoomSnapshot
}

function internalEnvelope(events: RoomStoreEvent[]): string {
  return JSON.stringify({ v: 1, events } satisfies InternalEventEnvelope)
}

function parseInternalEnvelope(raw: string): InternalEventEnvelope {
  const value = JSON.parse(raw) as unknown
  if (!isPlainObject(value) || value.v !== 1 || !Array.isArray(value.events)) {
    throw new Error('Invalid Redis event envelope')
  }
  return value as unknown as InternalEventEnvelope
}

export class RoomStore {
  readonly #client: RedisClientType
  readonly #subscriber: RedisClientType
  readonly #listeners = new Set<(event: RoomStoreEvent) => void>()
  readonly #base: string
  readonly #channel: string
  readonly #roomTtlMs: number
  readonly #maxRooms: number
  readonly #maxMembers: number
  readonly #maxRoomsPerIp: number
  readonly #roomCreateAttemptsPerMinute: number
  readonly #maxConnections: number
  readonly #maxConnectionsPerIp: number
  readonly #heartbeatIntervalMs: number
  readonly #disconnectGraceMs: number
  readonly #challengeTtlMs: number
  readonly #ipHashSecret: string
  #healthy = false

  constructor(options: RoomStoreOptions) {
    if (!/^[A-Za-z0-9:_-]{1,96}$/u.test(options.redisKeyPrefix)) {
      throw new Error('redisKeyPrefix contains unsupported characters')
    }
    if (options.roomTtlMs <= 0 || options.roomTtlMs > 24 * 60 * 60 * 1_000) {
      throw new Error('roomTtlMs must be between 1 millisecond and 24 hours')
    }
    this.#base = `${options.redisKeyPrefix}:{veilink:v1}`
    this.#channel = `${this.#base}:events`
    this.#roomTtlMs = options.roomTtlMs
    this.#maxRooms = options.maxRooms ?? 1_000
    this.#maxMembers = options.maxMembers ?? 8
    this.#maxRoomsPerIp = options.maxRoomsPerIp ?? 32
    this.#roomCreateAttemptsPerMinute = options.roomCreateAttemptsPerMinute ?? 20
    this.#maxConnections = options.maxConnections ?? 2_048
    this.#maxConnectionsPerIp = options.maxConnectionsPerIp ?? 64
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000
    this.#disconnectGraceMs = options.disconnectGraceMs ?? 30_000
    this.#challengeTtlMs = options.challengeTtlMs ?? 30_000
    this.#ipHashSecret = options.ipHashSecret
    this.#client = createClient({ url: options.redisUrl }) as RedisClientType
    this.#subscriber = this.#client.duplicate() as RedisClientType
    this.#client.on('error', () => { this.#healthy = false })
    this.#subscriber.on('error', () => { this.#healthy = false })
    this.#client.on('ready', () => { this.#healthy = this.#subscriber.isReady })
    this.#subscriber.on('ready', () => { this.#healthy = this.#client.isReady })
  }

  get disconnectGraceMs(): number {
    return this.#disconnectGraceMs
  }

  async connect(): Promise<void> {
    try {
      await this.#client.connect()
      await this.#subscriber.connect()
      await this.#subscriber.subscribe(this.#channel, (raw) => {
        try {
          const envelope = parseInternalEnvelope(raw)
          for (const event of envelope.events) {
            for (const listener of this.#listeners) listener(event)
          }
        } catch {
          this.#healthy = false
        }
      })
      await this.#client.ping()
      this.#healthy = true
    } catch (error) {
      if (this.#subscriber.isOpen) this.#subscriber.destroy()
      if (this.#client.isOpen) this.#client.destroy()
      throw error
    }
  }

  async close(): Promise<void> {
    this.#healthy = false
    this.#listeners.clear()
    if (this.#subscriber.isOpen) this.#subscriber.destroy()
    if (this.#client.isOpen) this.#client.destroy()
  }

  async isHealthy(): Promise<boolean> {
    if (!this.#healthy || !this.#client.isReady || !this.#subscriber.isReady) return false
    try {
      await this.#client.ping()
      return true
    } catch {
      this.#healthy = false
      return false
    }
  }

  onEvent(listener: (event: RoomStoreEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async hasRoom(roomId: string): Promise<boolean> {
    const raw = await this.#client.get(this.#roomKey(roomId))
    if (raw === null) return false
    parseRoom(raw)
    return true
  }

  async consumeRoomCreateAttempt(publicIp: string): Promise<boolean> {
    const result = await this.#client.eval(CREATE_RATE_SCRIPT, {
      keys: [`${this.#base}:rate:create:${this.#ipHash(publicIp)}`],
      arguments: ['60000', String(this.#roomCreateAttemptsPerMinute)],
    })
    return Number(result) === 1
  }

  async createRoom(input: {
    roomId: string
    admissionKey: Uint8Array
    nickname: string
    identityPublicKey: string
    transportId: string
    publicIp: string
  }): Promise<RoomSession> {
    const now = await this.#now()
    const expiresAt = now + this.#roomTtlMs
    const creatorIpHash = this.#ipHash(input.publicIp)
    const createdMember = this.#newMember(input, now)
    const member = createdMember.member
    const room: StoredRoom = {
      schemaVersion: 1,
      id: input.roomId,
      admissionKey: Buffer.from(input.admissionKey).toString('base64url'),
      snapshotVersion: 0,
      ownerId: member.id,
      creatorIpHash,
      createdAt: now,
      expiresAt,
      members: [member],
    }
    const leaseDeadline = now + this.#activeLeaseTtlMs()
    const result = Number(await this.#client.eval(CREATE_ROOM_SCRIPT, {
      keys: [
        this.#roomKey(room.id),
        this.#roomsKey(),
        this.#creatorKey(creatorIpHash),
        this.#leaseKey(room.id, member.id),
        this.#leasesKey(),
      ],
      arguments: [
        String(now),
        String(this.#maxRooms),
        String(this.#maxRoomsPerIp),
        serializeRoom(room),
        String(expiresAt),
        room.id,
        member.sessionId,
        String(this.#activeLeaseTtlMs()),
        String(leaseDeadline),
        this.#leaseRef(room.id, member.id),
      ],
    }))
    if (result === 1) throw new RoomStoreError('room_exists')
    if (result === 2) throw new RoomStoreError('server_capacity_reached')
    if (result === 3) throw new RoomStoreError('rate_limited')
    return this.#newSession(room, member, createdMember.resumeToken, now)
  }

  async joinRoom(input: {
    roomId: string
    nickname: string
    identityPublicKey: string
    transportId: string
  }): Promise<RoomSession> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const now = await this.#now()
      const loaded = await this.#loadRoom(input.roomId)
      const room = loaded.room
      if (room.members.length >= this.#maxMembers) throw new RoomStoreError('room_capacity_reached')
      if (room.members.some((member) => member.sessionId === input.transportId)) {
        throw new RoomStoreError('already_in_room')
      }
      const wasVacant = room.members.length === 0
      const createdMember = this.#newMember(input, now)
      const member = createdMember.member
      room.members.push(member)
      if (wasVacant) room.ownerId = member.id
      room.snapshotVersion += 1
      const roomSnapshot = snapshot(room, now)
      const events: RoomStoreEvent[] = [
        {
          kind: 'wire',
          roomId: room.id,
          excludedMemberId: member.id,
          event: {
            v: PROTOCOL_VERSION,
            type: 'room.member.joined',
            payload: { member: publicMember(room, member), snapshotVersion: room.snapshotVersion },
          },
        },
        {
          kind: 'wire',
          roomId: room.id,
          excludedMemberId: member.id,
          event: { v: PROTOCOL_VERSION, type: 'room.snapshot', payload: roomSnapshot },
        },
      ]
      const changed = await this.#casRoom({
        expected: loaded.raw,
        room,
        events,
        leaseAction: 'set',
        leaseMemberId: member.id,
        leaseSessionId: member.sessionId,
        now,
      })
      if (changed) return this.#newSession(room, member, createdMember.resumeToken, now)
    }
    throw new Error('Redis room update contention exceeded retry limit')
  }

  async resumeRoom(input: {
    roomId: string
    memberId: string
    resumeToken: string
    identityPublicKey: string
    transportId: string
  }): Promise<RoomSession> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const now = await this.#now()
      const loaded = await this.#loadRoom(input.roomId)
      const member = loaded.room.members.find((item) => item.id === input.memberId)
      const suppliedHash = hashResumeToken(input.resumeToken)
      const storedHash = member === undefined ? Buffer.alloc(32) : Buffer.from(member.resumeTokenHash, 'hex')
      const valid = member !== undefined &&
        member.identityPublicKey === input.identityPublicKey &&
        safeEqual(storedHash, suppliedHash) &&
        await this.#client.exists(this.#leaseKey(input.roomId, input.memberId)) === 1
      suppliedHash.fill(0)
      storedHash.fill(0)
      if (!valid || member === undefined) throw new RoomStoreError('resume_rejected')

      const previousSessionId = member.sessionId
      member.sessionId = input.transportId
      const resumeToken = randomId(32)
      member.resumeTokenHash = hashResumeToken(resumeToken).toString('hex')
      loaded.room.snapshotVersion += 1
      const roomSnapshot = snapshot(loaded.room, now)
      const events: RoomStoreEvent[] = [
        {
          kind: 'session-replaced',
          roomId: loaded.room.id,
          memberId: member.id,
          sessionId: previousSessionId,
        },
        {
          kind: 'wire',
          roomId: loaded.room.id,
          excludedMemberId: member.id,
          event: { v: PROTOCOL_VERSION, type: 'room.snapshot', payload: roomSnapshot },
        },
      ]
      const changed = await this.#casRoom({
        expected: loaded.raw,
        room: loaded.room,
        events,
        leaseAction: 'set',
        leaseMemberId: member.id,
        leaseSessionId: member.sessionId,
        now,
      })
      if (changed) {
        return {
          memberId: member.id,
          sessionId: member.sessionId,
          resumeToken,
          snapshot: roomSnapshot,
        }
      }
    }
    throw new Error('Redis room update contention exceeded retry limit')
  }

  async issueChallenge(input: {
    roomId: string
    transportId: string
    publicIp: string
    nickname: string
    identityPublicKey: string
  }): Promise<{ challengeId: string; nonce: string; expiresAt: number }> {
    if (!await this.hasRoom(input.roomId)) throw new RoomStoreError('room_not_found')
    const publicIpHash = this.#ipHash(input.publicIp)
    if (!await this.#canAttemptAdmission(input.roomId, publicIpHash)) {
      throw new RoomStoreError('rate_limited')
    }
    const now = await this.#now()
    const challenge: StoredChallenge = {
      id: randomId(16),
      nonce: randomId(32),
      roomId: input.roomId,
      transportId: input.transportId,
      publicIpHash,
      nickname: input.nickname,
      identityPublicKey: input.identityPublicKey,
      expiresAt: now + this.#challengeTtlMs,
    }
    const created = await this.#client.set(this.#challengeKey(challenge.id), JSON.stringify(challenge), {
      PX: this.#challengeTtlMs,
      NX: true,
    })
    if (created !== 'OK') throw new RoomStoreError('rate_limited')
    return { challengeId: challenge.id, nonce: challenge.nonce, expiresAt: challenge.expiresAt }
  }

  async consumeChallenge(input: {
    roomId: string
    challengeId: string
    proof: string
    transportId: string
    publicIp: string
    nickname: string
    identityPublicKey: string
  }): Promise<void> {
    const publicIpHash = this.#ipHash(input.publicIp)
    if (!await this.#canAttemptAdmission(input.roomId, publicIpHash)) {
      throw new RoomStoreError('rate_limited')
    }
    const raw = await this.#client.getDel(this.#challengeKey(input.challengeId))
    const now = await this.#now()
    if (raw === null) {
      await this.#recordAdmissionFailure(input.roomId, publicIpHash)
      throw new RoomStoreError('challenge_rejected')
    }
    const challenge = parseChallenge(raw)
    if (
      challenge.expiresAt <= now ||
      challenge.roomId !== input.roomId ||
      challenge.transportId !== input.transportId ||
      challenge.publicIpHash !== publicIpHash ||
      challenge.nickname !== input.nickname ||
      challenge.identityPublicKey !== input.identityPublicKey
    ) {
      await this.#recordAdmissionFailure(input.roomId, publicIpHash)
      throw new RoomStoreError('challenge_rejected')
    }
    const loaded = await this.#loadRoom(input.roomId)
    const key = Buffer.from(loaded.room.admissionKey, 'base64url')
    const verified = verifyAdmissionProof(
      key,
      { roomId: input.roomId, challengeId: challenge.id, nonce: challenge.nonce },
      input.proof,
    )
    key.fill(0)
    if (!verified) {
      await this.#recordAdmissionFailure(input.roomId, publicIpHash)
      throw new RoomStoreError('admission_failed')
    }
  }

  async touch(roomId: string, memberId: string, sessionId: string): Promise<RoomSnapshot | undefined> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const now = await this.#now()
      const loaded = await this.#loadRoomOptional(roomId)
      if (loaded === undefined) return undefined
      const member = loaded.room.members.find((item) => item.id === memberId)
      if (member?.sessionId !== sessionId) return undefined
      const deadline = now + this.#activeLeaseTtlMs()
      const result = Number(await this.#client.eval(TOUCH_SESSION_SCRIPT, {
        keys: [this.#roomKey(roomId), this.#leaseKey(roomId, memberId), this.#leasesKey()],
        arguments: [loaded.raw, sessionId, String(this.#activeLeaseTtlMs()), String(deadline), this.#leaseRef(roomId, memberId)],
      }))
      if (result === 1) return snapshot(loaded.room, now)
    }
    return undefined
  }

  async disconnect(roomId: string, memberId: string, sessionId: string): Promise<void> {
    const now = await this.#now()
    await this.#client.eval(DISCONNECT_SESSION_SCRIPT, {
      keys: [this.#leaseKey(roomId, memberId), this.#leasesKey()],
      arguments: [sessionId, String(this.#disconnectGraceMs), String(now + this.#disconnectGraceMs), this.#leaseRef(roomId, memberId)],
    })
  }

  async leave(roomId: string, memberId: string, sessionId: string): Promise<void> {
    await this.#removeMember(roomId, memberId, sessionId, 'left', true)
  }

  async destroyByOwner(roomId: string, memberId: string, sessionId: string): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const loaded = await this.#loadRoom(roomId)
      const member = loaded.room.members.find((item) => item.id === memberId)
      if (member?.sessionId !== sessionId) throw new RoomStoreError('member_not_found')
      if (loaded.room.ownerId !== memberId) throw new RoomStoreError('not_owner')
      const events: RoomStoreEvent[] = [{
        kind: 'wire',
        roomId,
        event: { v: PROTOCOL_VERSION, type: 'room.ended', payload: { reason: 'destroyed-by-owner' } },
      }]
      const changed = await this.#casRoom({
        expected: loaded.raw,
        room: undefined,
        deletedRoom: loaded.room,
        events,
        leaseAction: 'delete',
        leaseMemberId: memberId,
        leaseSessionId: sessionId,
        now: await this.#now(),
      })
      if (changed) return
    }
    throw new Error('Redis room update contention exceeded retry limit')
  }

  async snapshotById(roomId: string): Promise<RoomSnapshot | undefined> {
    const now = await this.#now()
    const loaded = await this.#loadRoomOptional(roomId)
    return loaded === undefined || loaded.room.members.length === 0
      ? undefined
      : snapshot(loaded.room, now)
  }

  async forwardRtcEvent(input: {
    roomId: string
    senderId: string
    sessionId: string
    targetMemberId: string
    type: 'rtc.description' | 'rtc.candidate'
    data: unknown
  }): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const loaded = await this.#loadRoom(input.roomId)
      const sender = loaded.room.members.find((member) => member.id === input.senderId)
      if (sender?.sessionId !== input.sessionId) throw new RoomStoreError('member_not_found')
      const target = loaded.room.members.find((member) => member.id === input.targetMemberId)
      if (target === undefined) throw new RoomStoreError('target_not_found')
      const event: RoomStoreWireEvent = {
        kind: 'wire',
        roomId: input.roomId,
        targetMemberId: target.id,
        targetSessionId: target.sessionId,
        event: {
          v: PROTOCOL_VERSION,
          type: input.type,
          payload: {
            fromMemberId: input.senderId,
            ...(input.type === 'rtc.description' ? { description: input.data } : { candidate: input.data }),
          },
        },
      }
      const result = Number(await this.#client.eval(AUTHORIZE_PUBLISH_SCRIPT, {
        keys: [
          this.#roomKey(input.roomId),
          this.#leaseKey(input.roomId, sender.id),
          this.#leaseKey(input.roomId, target.id),
          this.#channel,
        ],
        arguments: [loaded.raw, sender.sessionId, target.sessionId, internalEnvelope([event])],
      }))
      if (result === 1) return
      if (result === -1) throw new RoomStoreError('member_not_found')
      if (result === -2) throw new RoomStoreError('target_not_found')
    }
    throw new Error('Redis room authorization contention exceeded retry limit')
  }

  async authorize(roomId: string, memberId: string, sessionId: string): Promise<boolean> {
    const loaded = await this.#loadRoomOptional(roomId)
    if (loaded === undefined) return false
    const member = loaded.room.members.find((item) => item.id === memberId)
    if (member?.sessionId !== sessionId) return false
    return await this.#client.get(this.#leaseKey(roomId, memberId)) === sessionId
  }

  async registerConnection(connectionId: string, publicIp: string): Promise<boolean> {
    const now = await this.#now()
    const ipHash = this.#ipHash(publicIp)
    const ttl = this.#activeLeaseTtlMs()
    const result = await this.#client.eval(REGISTER_CONNECTION_SCRIPT, {
      keys: [this.#connectionsKey(), this.#connectionsByIpKey(ipHash), this.#connectionKey(connectionId)],
      arguments: [String(now), String(this.#maxConnections), String(this.#maxConnectionsPerIp), connectionId, String(ttl), String(now + ttl)],
    })
    return Number(result) === 1
  }

  async refreshConnection(connectionId: string, publicIp: string): Promise<boolean> {
    const now = await this.#now()
    const ttl = this.#activeLeaseTtlMs()
    const result = await this.#client.eval(REFRESH_CONNECTION_SCRIPT, {
      keys: [this.#connectionKey(connectionId), this.#connectionsKey(), this.#connectionsByIpKey(this.#ipHash(publicIp))],
      arguments: [connectionId, String(ttl), String(now + ttl)],
    })
    return Number(result) === 1
  }

  async removeConnection(connectionId: string, publicIp: string): Promise<void> {
    await this.#client.eval(REMOVE_CONNECTION_SCRIPT, {
      keys: [this.#connectionKey(connectionId), this.#connectionsKey(), this.#connectionsByIpKey(this.#ipHash(publicIp))],
      arguments: [connectionId],
    })
  }

  async sweep(): Promise<void> {
    const now = await this.#now()
    const expiredRooms = await this.#client.zRangeByScore(this.#roomsKey(), 0, now, { LIMIT: { offset: 0, count: 100 } })
    for (const roomId of expiredRooms) {
      const ended: RoomStoreWireEvent = {
        kind: 'wire',
        roomId,
        event: { v: PROTOCOL_VERSION, type: 'room.ended', payload: { reason: 'expired' } },
      }
      await this.#client.eval(CLAIM_EXPIRED_ROOM_SCRIPT, {
        keys: [this.#roomKey(roomId), this.#roomsKey(), this.#channel],
        arguments: [roomId, String(now), internalEnvelope([ended])],
      })
    }

    const expiredLeases = await this.#client.zRangeByScore(this.#leasesKey(), 0, now, { LIMIT: { offset: 0, count: 200 } })
    for (const reference of expiredLeases) {
      const [roomId, memberId, extra] = reference.split('.')
      if (!roomId || !memberId || extra !== undefined) {
        await this.#client.zRem(this.#leasesKey(), reference)
        continue
      }
      if (await this.#client.exists(this.#leaseKey(roomId, memberId)) === 1) continue
      try {
        await this.#removeMember(roomId, memberId, undefined, 'disconnected', false)
      } catch (error) {
        if (!(error instanceof RoomStoreError && error.code === 'room_not_found')) throw error
        await this.#client.zRem(this.#leasesKey(), reference)
      }
    }
  }

  async #removeMember(
    roomId: string,
    memberId: string,
    requiredSessionId: string | undefined,
    reason: 'left' | 'disconnected',
    requireLease: boolean,
  ): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const now = await this.#now()
      const loaded = await this.#loadRoom(roomId)
      const member = loaded.room.members.find((item) => item.id === memberId)
      if (member === undefined) {
        await this.#client.zRem(this.#leasesKey(), this.#leaseRef(roomId, memberId))
        return
      }
      if (requiredSessionId !== undefined && member.sessionId !== requiredSessionId) {
        throw new RoomStoreError('member_not_found')
      }
      if (!requireLease && await this.#client.exists(this.#leaseKey(roomId, memberId)) === 1) {
        return
      }
      if (requireLease && await this.#client.get(this.#leaseKey(roomId, memberId)) !== member.sessionId) {
        throw new RoomStoreError('member_not_found')
      }
      const ownerChanged = loaded.room.ownerId === memberId
      loaded.room.members = loaded.room.members.filter((item) => item.id !== memberId)
      if (loaded.room.members.length === 0) {
        loaded.room.ownerId = null
      } else if (ownerChanged) {
        loaded.room.ownerId = [...loaded.room.members]
          .sort((left, right) => left.joinedAt - right.joinedAt || left.id.localeCompare(right.id))[0]!.id
      }
      loaded.room.snapshotVersion += 1
      const events: RoomStoreEvent[] = []
      if (loaded.room.members.length > 0) {
        events.push({
          kind: 'wire',
          roomId,
          event: {
            v: PROTOCOL_VERSION,
            type: 'room.member.left',
            payload: { memberId, reason, snapshotVersion: loaded.room.snapshotVersion },
          },
        })
        if (ownerChanged && loaded.room.ownerId !== null) {
          events.push({
            kind: 'wire',
            roomId,
            event: {
              v: PROTOCOL_VERSION,
              type: 'room.owner.changed',
              payload: { ownerId: loaded.room.ownerId, snapshotVersion: loaded.room.snapshotVersion },
            },
          })
        }
        events.push({
          kind: 'wire',
          roomId,
          event: { v: PROTOCOL_VERSION, type: 'room.snapshot', payload: snapshot(loaded.room, now) },
        })
      }
      const changed = await this.#casRoom({
        expected: loaded.raw,
        room: loaded.room,
        events,
        leaseAction: 'delete',
        leaseMemberId: memberId,
        leaseSessionId: member.sessionId,
        now,
      })
      if (changed) return
    }
    throw new Error('Redis room update contention exceeded retry limit')
  }

  async #casRoom(input: {
    expected: string
    room: StoredRoom | undefined
    deletedRoom?: StoredRoom
    events: RoomStoreEvent[]
    leaseAction: 'set' | 'delete' | 'none'
    leaseMemberId?: string
    leaseSessionId?: string
    now: number
  }): Promise<boolean> {
    const source = input.room ?? input.deletedRoom
    if (source === undefined) throw new Error('CAS room source is required')
    const leaseMemberId = input.leaseMemberId ?? '_'
    const leaseSessionId = input.leaseSessionId ?? ''
    const leaseTtl = this.#activeLeaseTtlMs()
    const result = await this.#client.eval(CAS_ROOM_SCRIPT, {
      keys: [
        this.#roomKey(source.id),
        this.#roomsKey(),
        this.#leasesKey(),
        this.#channel,
        this.#leaseKey(source.id, leaseMemberId),
        this.#creatorKey(source.creatorIpHash),
      ],
      arguments: [
        input.expected,
        input.room === undefined ? '' : serializeRoom(input.room),
        String(source.expiresAt),
        source.id,
        input.events.length === 0 ? '' : internalEnvelope(input.events),
        input.leaseAction,
        leaseSessionId,
        String(leaseTtl),
        String(input.now + leaseTtl),
        this.#leaseRef(source.id, leaseMemberId),
        source.creatorIpHash,
        input.room === undefined ? '1' : '0',
      ],
    })
    return Number(result) === 1
  }

  async #loadRoom(roomId: string): Promise<{ raw: string; room: StoredRoom }> {
    const loaded = await this.#loadRoomOptional(roomId)
    if (loaded === undefined) throw new RoomStoreError('room_not_found')
    return loaded
  }

  async #loadRoomOptional(roomId: string): Promise<{ raw: string; room: StoredRoom } | undefined> {
    const raw = await this.#client.get(this.#roomKey(roomId))
    if (raw === null) return undefined
    const room = parseRoom(raw)
    if (room.id !== roomId) throw new Error('Redis room key does not match record')
    return { raw, room }
  }

  #newMember(
    input: { nickname: string; identityPublicKey: string; transportId: string },
    now: number,
  ): { member: StoredMember; resumeToken: string } {
    const resumeToken = randomId(32)
    return {
      resumeToken,
      member: {
        id: randomId(16),
        nickname: input.nickname,
        identityPublicKey: input.identityPublicKey,
        joinedAt: now,
        resumeTokenHash: hashResumeToken(resumeToken).toString('hex'),
        sessionId: input.transportId,
      },
    }
  }

  #newSession(room: StoredRoom, member: StoredMember, resumeToken: string, now: number): RoomSession {
    return {
      memberId: member.id,
      sessionId: member.sessionId,
      resumeToken,
      snapshot: snapshot(room, now),
    }
  }

  async #canAttemptAdmission(roomId: string, publicIpHash: string): Promise<boolean> {
    const result = await this.#client.eval(CAN_ADMIT_SCRIPT, {
      keys: [this.#admissionPairKey(roomId, publicIpHash), this.#admissionRoomKey(roomId)],
      arguments: ['5', '30'],
    })
    return Number(result) === 1
  }

  async #recordAdmissionFailure(roomId: string, publicIpHash: string): Promise<void> {
    await this.#client.eval(RECORD_ADMISSION_FAILURE_SCRIPT, {
      keys: [this.#admissionPairKey(roomId, publicIpHash), this.#admissionRoomKey(roomId)],
      arguments: [String(10 * 60_000)],
    })
  }

  async #now(): Promise<number> {
    const reply = await this.#client.sendCommand(['TIME']) as unknown
    if (!Array.isArray(reply) || reply.length !== 2) throw new Error('Invalid Redis TIME response')
    const seconds = Number(reply[0])
    const microseconds = Number(reply[1])
    if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(microseconds)) {
      throw new Error('Invalid Redis TIME response')
    }
    return seconds * 1_000 + Math.floor(microseconds / 1_000)
  }

  #activeLeaseTtlMs(): number {
    return this.#disconnectGraceMs + this.#heartbeatIntervalMs
  }

  #ipHash(publicIp: string): string {
    return createHmac('sha256', this.#ipHashSecret)
      .update('veilink-redis-ip\0')
      .update(publicIp)
      .digest('base64url')
  }

  #roomKey(roomId: string): string { return `${this.#base}:room:${roomId}` }
  #roomsKey(): string { return `${this.#base}:rooms` }
  #creatorKey(hash: string): string { return `${this.#base}:creator:${hash}` }
  #leaseKey(roomId: string, memberId: string): string { return `${this.#base}:lease:${roomId}:${memberId}` }
  #leaseRef(roomId: string, memberId: string): string { return `${roomId}.${memberId}` }
  #leasesKey(): string { return `${this.#base}:leases` }
  #challengeKey(challengeId: string): string { return `${this.#base}:challenge:${challengeId}` }
  #admissionPairKey(roomId: string, hash: string): string { return `${this.#base}:rate:admission:${roomId}:${hash}` }
  #admissionRoomKey(roomId: string): string { return `${this.#base}:rate:admission:${roomId}` }
  #connectionsKey(): string { return `${this.#base}:connections` }
  #connectionsByIpKey(hash: string): string { return `${this.#base}:connections:ip:${hash}` }
  #connectionKey(connectionId: string): string { return `${this.#base}:connection:${connectionId}` }
}

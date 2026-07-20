import { PROTOCOL_VERSION, type PublicMember, type RoomEndReason, type RoomSnapshot } from '@veilink/protocol'

import { hashResumeToken, randomId, safeEqual, verifyAdmissionProof } from './security.js'

export interface WireEvent {
  v: typeof PROTOCOL_VERSION
  type: string
  requestId?: string
  payload: unknown
}

export type EventSink = (event: WireEvent) => void

export interface RoomSession {
  memberId: string
  resumeToken: string
  snapshot: RoomSnapshot
}

type MemberExitReason = 'left' | 'timeout' | 'disconnected'

interface Member {
  id: string
  nickname: string
  identityPublicKey: string
  joinedAt: number
  connected: boolean
  resumeTokenHash: Buffer
  transportId?: string
  sink?: EventSink
  disconnectDeadline?: number
}

interface Room {
  id: string
  admissionKey: Buffer
  snapshotVersion: number
  ownerId: string | undefined
  createdAt: number
  expiresAt: number
  members: Map<string, Member>
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

export class RoomStoreError extends Error {
  constructor(readonly code: RoomStoreErrorCode) {
    super(code)
    this.name = 'RoomStoreError'
  }
}

export interface RoomStoreOptions {
  roomTtlMs: number
  maxRooms?: number
  maxMembers?: number
  disconnectGraceMs?: number
  now?: () => number
}

export class RoomStore {
  readonly #rooms = new Map<string, Room>()
  readonly #destroyListeners = new Set<(roomId: string) => void>()
  readonly #roomTtlMs: number
  readonly #maxRooms: number
  readonly #maxMembers: number
  readonly #disconnectGraceMs: number
  readonly #now: () => number

  constructor(options: RoomStoreOptions) {
    if (options.roomTtlMs <= 0 || options.roomTtlMs > 24 * 60 * 60 * 1_000) {
      throw new Error('roomTtlMs must be between 1 millisecond and 24 hours')
    }
    if ((options.maxMembers ?? 8) < 1 || (options.maxMembers ?? 8) > 8) {
      throw new Error('maxMembers must be between 1 and 8')
    }
    this.#roomTtlMs = options.roomTtlMs
    this.#maxRooms = options.maxRooms ?? 1_000
    this.#maxMembers = options.maxMembers ?? 8
    this.#disconnectGraceMs = options.disconnectGraceMs ?? 30_000
    this.#now = options.now ?? Date.now
  }

  get size(): number {
    return this.#rooms.size
  }

  hasRoom(roomId: string): boolean {
    return this.#rooms.has(roomId)
  }

  onDestroyed(listener: (roomId: string) => void): () => void {
    this.#destroyListeners.add(listener)
    return () => this.#destroyListeners.delete(listener)
  }

  createRoom(input: {
    roomId: string
    admissionKey: Uint8Array
    nickname: string
    identityPublicKey: string
    transportId: string
    sink: EventSink
  }): RoomSession {
    if (this.#rooms.has(input.roomId)) throw new RoomStoreError('room_exists')
    if (this.#rooms.size >= this.#maxRooms) throw new RoomStoreError('server_capacity_reached')

    const now = this.#now()
    const member = this.#newMember(input, now)
    const room: Room = {
      id: input.roomId,
      admissionKey: Buffer.from(input.admissionKey),
      snapshotVersion: 0,
      ownerId: member.id,
      createdAt: now,
      expiresAt: now + this.#roomTtlMs,
      members: new Map([[member.id, member]]),
    }
    this.#rooms.set(room.id, room)
    return this.#newSession(room, member)
  }

  joinRoom(input: {
    roomId: string
    nickname: string
    identityPublicKey: string
    transportId: string
    sink: EventSink
  }): RoomSession {
    const room = this.#getRoom(input.roomId)
    if (room.members.size >= this.#maxMembers) throw new RoomStoreError('room_capacity_reached')
    for (const member of room.members.values()) {
      if (member.transportId === input.transportId) throw new RoomStoreError('already_in_room')
    }

    const wasVacant = room.members.size === 0
    const member = this.#newMember(input, this.#now())
    room.members.set(member.id, member)
    if (wasVacant) room.ownerId = member.id
    room.snapshotVersion += 1
    this.#broadcast(
      room,
      {
        v: PROTOCOL_VERSION,
        type: 'room.member.joined',
        payload: {
          member: this.#publicMember(room, member),
          snapshotVersion: room.snapshotVersion,
        },
      },
      member.id,
    )
    this.#broadcastSnapshot(room, member.id)
    return this.#newSession(room, member)
  }

  resumeRoom(input: {
    roomId: string
    memberId: string
    resumeToken: string
    identityPublicKey: string
    transportId: string
    sink: EventSink
  }): RoomSession {
    const room = this.#getRoom(input.roomId)
    const member = room.members.get(input.memberId)
    const suppliedHash = hashResumeToken(input.resumeToken)
    if (
      member === undefined ||
      member.connected ||
      member.identityPublicKey !== input.identityPublicKey ||
      member.disconnectDeadline === undefined ||
      member.disconnectDeadline <= this.#now() ||
      !safeEqual(member.resumeTokenHash, suppliedHash)
    ) {
      suppliedHash.fill(0)
      throw new RoomStoreError('resume_rejected')
    }
    suppliedHash.fill(0)

    member.transportId = input.transportId
    member.sink = input.sink
    member.connected = true
    delete member.disconnectDeadline
    room.snapshotVersion += 1
    const resumeToken = this.#rotateResumeToken(member)
    this.#broadcastSnapshot(room, member.id)
    return { memberId: member.id, resumeToken, snapshot: this.snapshot(room) }
  }

  verifyAdmission(
    roomId: string,
    challenge: { challengeId: string; nonce: string },
    proof: string,
  ): boolean {
    const room = this.#rooms.get(roomId)
    return room === undefined
      ? false
      : verifyAdmissionProof(
          room.admissionKey,
          { roomId, challengeId: challenge.challengeId, nonce: challenge.nonce },
          proof,
        )
  }

  touch(roomId: string, memberId: string, transportId: string): boolean {
    const member = this.#rooms.get(roomId)?.members.get(memberId)
    return member?.connected === true && member.transportId === transportId
  }

  disconnect(roomId: string, memberId: string, transportId: string): void {
    const room = this.#rooms.get(roomId)
    const member = room?.members.get(memberId)
    if (room === undefined || member === undefined || member.transportId !== transportId) return
    member.connected = false
    delete member.transportId
    delete member.sink
    member.disconnectDeadline = this.#now() + this.#disconnectGraceMs
  }

  leave(roomId: string, memberId: string, transportId: string): void {
    const room = this.#getRoom(roomId)
    const member = this.#getConnectedMember(room, memberId, transportId)
    this.#removeMember(room, member.id, 'left')
  }

  forwardRtcDescription(input: {
    roomId: string
    senderId: string
    transportId: string
    targetMemberId: string
    description: unknown
  }): void {
    this.#forwardRtcEvent({ ...input, type: 'rtc.description', data: input.description })
  }

  forwardRtcCandidate(input: {
    roomId: string
    senderId: string
    transportId: string
    targetMemberId: string
    candidate: unknown
  }): void {
    this.#forwardRtcEvent({ ...input, type: 'rtc.candidate', data: input.candidate })
  }

  destroyByOwner(roomId: string, memberId: string, transportId: string): void {
    const room = this.#getRoom(roomId)
    this.#getConnectedMember(room, memberId, transportId)
    if (room.ownerId !== memberId) throw new RoomStoreError('not_owner')
    this.#destroy(room, 'destroyed-by-owner')
  }

  snapshotById(roomId: string): RoomSnapshot | undefined {
    const room = this.#rooms.get(roomId)
    return room === undefined || room.members.size === 0 ? undefined : this.snapshot(room)
  }

  snapshot(room: Room): RoomSnapshot {
    const ownerId = room.ownerId
    if (room.members.size === 0 || ownerId === undefined || !room.members.has(ownerId)) {
      throw new Error('Cannot snapshot a room without an active owner')
    }
    const members = [...room.members.values()]
      .sort((left, right) => left.joinedAt - right.joinedAt || left.id.localeCompare(right.id))
      .map((member) => this.#publicMember(room, member))
    return {
      roomId: room.id,
      snapshotVersion: room.snapshotVersion,
      ownerId,
      members,
      createdAt: room.createdAt,
      expiresAt: room.expiresAt,
      serverNow: this.#now(),
    } as RoomSnapshot
  }

  sweep(): void {
    const now = this.#now()
    for (const room of [...this.#rooms.values()]) {
      if (room.expiresAt <= now) {
        this.#destroy(room, 'expired')
        continue
      }

      for (const member of [...room.members.values()]) {
        if (member.disconnectDeadline !== undefined && member.disconnectDeadline <= now) {
          this.#removeMember(room, member.id, 'disconnected')
          if (!this.#rooms.has(room.id)) break
        }
      }
    }
  }

  close(reason: RoomEndReason = 'server-restarted'): void {
    for (const room of [...this.#rooms.values()]) this.#destroy(room, reason)
  }

  #forwardRtcEvent(input: {
    roomId: string
    senderId: string
    transportId: string
    targetMemberId: string
    type: 'rtc.description' | 'rtc.candidate'
    data: unknown
  }): void {
    const room = this.#getRoom(input.roomId)
    this.#getConnectedMember(room, input.senderId, input.transportId)
    const target = room.members.get(input.targetMemberId)
    if (target?.connected !== true || target.sink === undefined) {
      throw new RoomStoreError('target_not_found')
    }
    this.#emit(target, {
      v: PROTOCOL_VERSION,
      type: input.type,
      payload: {
        fromMemberId: input.senderId,
        ...(input.type === 'rtc.description'
          ? { description: input.data }
          : { candidate: input.data }),
      },
    })
  }

  #getRoom(roomId: string): Room {
    const room = this.#rooms.get(roomId)
    if (room === undefined) throw new RoomStoreError('room_not_found')
    return room
  }

  #getConnectedMember(room: Room, memberId: string, transportId: string): Member {
    const member = room.members.get(memberId)
    if (member?.connected !== true || member.transportId !== transportId) {
      throw new RoomStoreError('member_not_found')
    }
    return member
  }

  #newMember(
    input: {
      nickname: string
      identityPublicKey: string
      transportId: string
      sink: EventSink
    },
    now: number,
  ): Member {
    return {
      id: randomId(16),
      nickname: input.nickname,
      identityPublicKey: input.identityPublicKey,
      joinedAt: now,
      connected: true,
      resumeTokenHash: Buffer.alloc(32),
      transportId: input.transportId,
      sink: input.sink,
    }
  }

  #newSession(room: Room, member: Member): RoomSession {
    const resumeToken = this.#rotateResumeToken(member)
    return { memberId: member.id, resumeToken, snapshot: this.snapshot(room) }
  }

  #rotateResumeToken(member: Member): string {
    const resumeToken = randomId(32)
    member.resumeTokenHash.fill(0)
    member.resumeTokenHash = hashResumeToken(resumeToken)
    return resumeToken
  }

  #removeMember(room: Room, memberId: string, reason: MemberExitReason): void {
    const member = room.members.get(memberId)
    if (member === undefined) return
    const ownerChanged = room.ownerId === memberId
    member.resumeTokenHash.fill(0)
    room.members.delete(memberId)

    if (room.members.size === 0) {
      room.ownerId = undefined
      room.snapshotVersion += 1
      return
    }

    if (ownerChanged) {
      const replacement = [...room.members.values()].sort(
        (left, right) =>
          Number(right.connected) - Number(left.connected) ||
          left.joinedAt - right.joinedAt ||
          left.id.localeCompare(right.id),
      )[0]
      if (replacement !== undefined) room.ownerId = replacement.id
    }
    room.snapshotVersion += 1
    this.#broadcast(room, {
      v: PROTOCOL_VERSION,
      type: 'room.member.left',
      payload: { memberId, reason, snapshotVersion: room.snapshotVersion },
    })
    if (ownerChanged) {
      const newOwner = room.ownerId === undefined ? undefined : room.members.get(room.ownerId)
      if (newOwner !== undefined) {
        this.#broadcast(room, {
          v: PROTOCOL_VERSION,
          type: 'room.owner.changed',
          payload: { ownerId: newOwner.id, snapshotVersion: room.snapshotVersion },
        })
      }
    }

    this.#broadcastSnapshot(room)
  }

  #destroy(room: Room, reason: RoomEndReason): void {
    if (!this.#rooms.delete(room.id)) return
    this.#broadcast(room, { v: PROTOCOL_VERSION, type: 'room.ended', payload: { reason } })
    room.admissionKey.fill(0)
    for (const member of room.members.values()) member.resumeTokenHash.fill(0)
    room.members.clear()
    for (const listener of this.#destroyListeners) listener(room.id)
  }

  #broadcastSnapshot(room: Room, excludedMemberId?: string): void {
    this.#broadcast(
      room,
      { v: PROTOCOL_VERSION, type: 'room.snapshot', payload: this.snapshot(room) },
      excludedMemberId,
    )
  }

  #publicMember(room: Room, member: Member): PublicMember {
    return {
      memberId: member.id,
      nickname: member.nickname,
      identityPublicKey: member.identityPublicKey,
      joinedAt: member.joinedAt,
      isOwner: member.id === room.ownerId,
    } as PublicMember
  }

  #broadcast(room: Room, event: WireEvent, excludedMemberId?: string): void {
    for (const member of room.members.values()) {
      if (member.id !== excludedMemberId) this.#emit(member, event)
    }
  }

  #emit(member: Member, event: WireEvent): void {
    if (!member.connected || member.sink === undefined) return
    try {
      member.sink(event)
    } catch {
      // Sending is best effort. Socket lifecycle handling will detach the member.
    }
  }
}

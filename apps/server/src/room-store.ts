import type {
  PublicMember,
  RoomEndReason,
  RoomMode,
  RoomSnapshot,
} from '@veilink/protocol'

import { hashResumeToken, randomId, safeEqual, verifyAdmissionProof } from './security.js'

export interface WireEvent {
  v: 1
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

type MemberExitReason = 'left' | 'timeout' | 'disconnected' | 'mode-switch-failed'

interface Member {
  id: string
  nickname: string
  identityPublicKey: string
  publicIp: string
  joinedAt: number
  connected: boolean
  resumeTokenHash: Buffer
  transportId?: string
  sink?: EventSink
  disconnectDeadline?: number
}

interface PendingModeSwitch {
  target: RoomMode
  version: number
  deadline: number
  requestedBy: string
  required: Set<string>
  acknowledged: Set<string>
}

interface Room {
  id: string
  admissionKey: Buffer
  mode: RoomMode
  modeVersion: number
  snapshotVersion: number
  ownerId: string
  createdAt: number
  expiresAt: number
  members: Map<string, Member>
  pendingMode?: PendingModeSwitch
}

export type RoomStoreErrorCode =
  | 'room_exists'
  | 'room_not_found'
  | 'room_capacity_reached'
  | 'server_capacity_reached'
  | 'mode_switching'
  | 'already_in_room'
  | 'member_not_found'
  | 'resume_rejected'
  | 'not_owner'
  | 'invalid_mode'
  | 'invalid_mode_version'
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
  modeSwitchTimeoutMs?: number
  now?: () => number
}

export class RoomStore {
  readonly #rooms = new Map<string, Room>()
  readonly #destroyListeners = new Set<(roomId: string) => void>()
  readonly #roomTtlMs: number
  readonly #maxRooms: number
  readonly #maxMembers: number
  readonly #disconnectGraceMs: number
  readonly #modeSwitchTimeoutMs: number
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
    this.#modeSwitchTimeoutMs = options.modeSwitchTimeoutMs ?? 30_000
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

  getRoomMode(roomId: string): { mode: RoomMode; modeVersion: number } | undefined {
    const room = this.#rooms.get(roomId)
    return room === undefined ? undefined : { mode: room.mode, modeVersion: room.modeVersion }
  }

  canIssueTurnCredentials(roomId: string): boolean {
    const room = this.#rooms.get(roomId)
    return room?.mode === 'turn' || room?.pendingMode?.target === 'turn'
  }

  createRoom(input: {
    roomId: string
    admissionKey: Uint8Array
    mode: RoomMode
    nickname: string
    identityPublicKey: string
    publicIp: string
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
      mode: input.mode,
      modeVersion: 1,
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
    publicIp: string
    transportId: string
    sink: EventSink
  }): RoomSession {
    const room = this.#getRoom(input.roomId)
    if (room.pendingMode !== undefined) throw new RoomStoreError('mode_switching')
    if (room.members.size >= this.#maxMembers) throw new RoomStoreError('room_capacity_reached')
    for (const member of room.members.values()) {
      if (member.transportId === input.transportId) throw new RoomStoreError('already_in_room')
    }

    const member = this.#newMember(input, this.#now())
    room.members.set(member.id, member)
    room.snapshotVersion += 1
    this.#broadcast(
      room,
      {
        v: 1,
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
    publicIp: string
    transportId: string
    sink: EventSink
  }): RoomSession {
    const room = this.#getRoom(input.roomId)
    if (room.pendingMode !== undefined) throw new RoomStoreError('mode_switching')
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

    member.publicIp = input.publicIp
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

  requestModeSwitch(
    roomId: string,
    memberId: string,
    transportId: string,
    target: RoomMode,
    expectedVersion: number,
  ): void {
    const room = this.#getRoom(roomId)
    this.#getConnectedMember(room, memberId, transportId)
    if (room.ownerId !== memberId) throw new RoomStoreError('not_owner')
    if (room.pendingMode !== undefined) throw new RoomStoreError('mode_switching')
    if (room.mode === target) throw new RoomStoreError('invalid_mode')
    if (room.modeVersion !== expectedVersion) throw new RoomStoreError('invalid_mode_version')

    const now = this.#now()
    const required = new Set(
      [...room.members.values()].filter((member) => member.connected).map((member) => member.id),
    )
    room.pendingMode = {
      target,
      version: room.modeVersion + 1,
      deadline: now + this.#modeSwitchTimeoutMs,
      requestedBy: memberId,
      required,
      acknowledged: new Set(),
    }
    this.#broadcast(room, {
      v: 1,
      type: 'room.mode.pending',
      payload: {
        previousMode: room.mode,
        mode: target,
        version: room.pendingMode.version,
        requestedBy: memberId,
        deadlineAt: room.pendingMode.deadline,
      },
    })
  }

  acknowledgeModeSwitch(
    roomId: string,
    memberId: string,
    transportId: string,
    version: number,
    status: 'ready' | 'failed',
  ): void {
    const room = this.#getRoom(roomId)
    this.#getConnectedMember(room, memberId, transportId)
    const pending = room.pendingMode
    if (pending === undefined || pending.version !== version || !pending.required.has(memberId)) {
      throw new RoomStoreError('invalid_mode_version')
    }
    if (status === 'failed') {
      this.#removeMember(room, memberId, 'mode-switch-failed')
      return
    }
    pending.acknowledged.add(memberId)
    if (pending.acknowledged.size === pending.required.size) this.#commitMode(room)
  }

  forwardRtcDescription(input: {
    roomId: string
    senderId: string
    transportId: string
    targetMemberId: string
    modeVersion: number
    generation: number
    description: unknown
  }): void {
    this.#forwardRtcEvent({ ...input, type: 'rtc.description', data: input.description })
  }

  forwardRtcCandidate(input: {
    roomId: string
    senderId: string
    transportId: string
    targetMemberId: string
    modeVersion: number
    generation: number
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
    return room === undefined ? undefined : this.snapshot(room)
  }

  snapshot(room: Room): RoomSnapshot {
    const members = [...room.members.values()]
      .sort((left, right) => left.joinedAt - right.joinedAt || left.id.localeCompare(right.id))
      .map((member) => this.#publicMember(room, member))
    return {
      roomId: room.id,
      mode: room.mode,
      modeVersion: room.modeVersion,
      snapshotVersion: room.snapshotVersion,
      ownerId: room.ownerId,
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
      if (!this.#rooms.has(room.id)) continue

      const pending = room.pendingMode
      if (pending !== undefined && pending.deadline <= now) {
        const unacknowledged = [...pending.required].filter(
          (memberId) => !pending.acknowledged.has(memberId),
        )
        for (const memberId of unacknowledged) {
          const member = room.members.get(memberId)
          if (member !== undefined) {
            this.#emit(member, {
              v: 1,
              type: 'error',
              payload: {
                code: 'mode_timeout',
                message: 'Mode switch acknowledgement timed out.',
              },
            })
          }
          this.#removeMember(room, memberId, 'mode-switch-failed')
          if (!this.#rooms.has(room.id)) break
        }
        if (this.#rooms.has(room.id) && room.pendingMode !== undefined) this.#commitMode(room)
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
    modeVersion: number
    generation: number
    type: 'rtc.description' | 'rtc.candidate'
    data: unknown
  }): void {
    const room = this.#getRoom(input.roomId)
    this.#getConnectedMember(room, input.senderId, input.transportId)
    if (room.pendingMode !== undefined) throw new RoomStoreError('mode_switching')
    if (room.modeVersion !== input.modeVersion) throw new RoomStoreError('invalid_mode_version')
    const target = room.members.get(input.targetMemberId)
    if (target?.connected !== true || target.sink === undefined) {
      throw new RoomStoreError('target_not_found')
    }
    this.#emit(target, {
      v: 1,
      type: input.type,
      payload: {
        fromMemberId: input.senderId,
        modeVersion: input.modeVersion,
        generation: input.generation,
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
      publicIp: string
      transportId: string
      sink: EventSink
    },
    now: number,
  ): Member {
    return {
      id: randomId(16),
      nickname: input.nickname,
      identityPublicKey: input.identityPublicKey,
      publicIp: input.publicIp,
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
    member.resumeTokenHash.fill(0)
    room.members.delete(memberId)
    room.pendingMode?.required.delete(memberId)
    room.pendingMode?.acknowledged.delete(memberId)

    if (room.members.size === 0) {
      this.#destroy(room, 'last-member-left')
      return
    }

    const ownerChanged = room.ownerId === memberId
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
      v: 1,
      type: 'room.member.left',
      payload: { memberId, reason, snapshotVersion: room.snapshotVersion },
    })
    if (ownerChanged) {
      const newOwner = room.members.get(room.ownerId)
      if (newOwner !== undefined) {
        this.#broadcast(room, {
          v: 1,
          type: 'room.owner.changed',
          payload: { ownerId: newOwner.id, snapshotVersion: room.snapshotVersion },
        })
      }
    }

    const pending = room.pendingMode
    if (pending !== undefined && pending.acknowledged.size === pending.required.size) {
      this.#commitMode(room)
    } else {
      this.#broadcastSnapshot(room)
    }
  }

  #commitMode(room: Room): void {
    const pending = room.pendingMode
    if (pending === undefined) return
    room.mode = pending.target
    room.modeVersion = pending.version
    room.snapshotVersion += 1
    delete room.pendingMode
    this.#broadcast(room, {
      v: 1,
      type: 'room.mode.changed',
      payload: { mode: room.mode, version: room.modeVersion },
    })
    this.#broadcastSnapshot(room)
  }

  #destroy(room: Room, reason: RoomEndReason): void {
    if (!this.#rooms.delete(room.id)) return
    this.#broadcast(room, { v: 1, type: 'room.ended', payload: { reason } })
    room.admissionKey.fill(0)
    for (const member of room.members.values()) member.resumeTokenHash.fill(0)
    room.members.clear()
    room.pendingMode?.required.clear()
    room.pendingMode?.acknowledged.clear()
    delete room.pendingMode
    for (const listener of this.#destroyListeners) listener(room.id)
  }

  #broadcastSnapshot(room: Room, excludedMemberId?: string): void {
    this.#broadcast(
      room,
      { v: 1, type: 'room.snapshot', payload: this.snapshot(room) },
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
      ...(room.mode === 'p2p' ? { publicIp: member.publicIp } : {}),
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

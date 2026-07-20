import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomSnapshotSchema } from '@veilink/protocol'
import { createClient } from 'redis'

import { RoomStore, RoomStoreError, type RoomStoreEvent } from '../src/room-store.js'
import { createAdmissionProof } from '../src/security.js'
import { clearRedisPrefix, testRedisUrl, testRoomStoreOptions } from './redis-test.js'

const ADMISSION_KEY = new Uint8Array(32).fill(7)
const IDENTITY_A = Buffer.alloc(32, 1).toString('base64url')
const IDENTITY_B = Buffer.alloc(32, 2).toString('base64url')
const IDENTITY_C = Buffer.alloc(32, 3).toString('base64url')
const ROOM_ID = 'AAAAAAAAAAAAAAAAAAAAAA'

interface Harness {
  store: RoomStore
  prefix: string
}

const harnesses: Harness[] = []

async function createHarness(label = 'room-store') {
  const options = testRoomStoreOptions(label)
  const store = new RoomStore(options)
  await store.connect()
  harnesses.push({ store, prefix: options.redisKeyPrefix })
  const owner = await store.createRoom({
    roomId: ROOM_ID,
    admissionKey: ADMISSION_KEY,
    nickname: 'Owner',
    identityPublicKey: IDENTITY_A,
    transportId: 'transport-owner',
    publicIp: '203.0.113.1',
  })
  return { store, owner, prefix: options.redisKeyPrefix }
}

afterEach(async () => {
  const active = harnesses.splice(0)
  await Promise.all(active.map(async ({ store, prefix }) => {
    await store.close()
    await clearRedisPrefix(prefix)
  }))
})

describe('Redis RoomStore', () => {
  it('stores privacy-safe room snapshots', async () => {
    const { owner } = await createHarness()
    expect(owner.snapshot.members[0]).not.toHaveProperty('publicIp')
    expect(RoomSnapshotSchema.safeParse(owner.snapshot).success).toBe(true)
  })

  it('never stores raw IPs or plaintext resume tokens in Redis', async () => {
    const { owner, prefix } = await createHarness()
    const client = createClient({ url: testRedisUrl() })
    await client.connect()
    try {
      const persisted: string[] = []
      for await (const keys of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) {
        persisted.push(...keys)
        for (const key of keys) {
          if (await client.type(key) === 'string') persisted.push(await client.get(key) ?? '')
        }
      }
      const serialized = persisted.join('\n')
      expect(serialized).not.toContain('203.0.113.1')
      expect(serialized).not.toContain(owner.resumeToken)
      expect(serialized).not.toContain('messageKey')
      expect(serialized).not.toContain('linkSecret')
    } finally {
      client.destroy()
    }
  })

  it('fails closed on an unsupported Redis room schema', async () => {
    const options = testRoomStoreOptions('corrupt-room')
    const store = new RoomStore(options)
    await store.connect()
    harnesses.push({ store, prefix: options.redisKeyPrefix })
    const client = createClient({ url: testRedisUrl() })
    await client.connect()
    try {
      await client.set(
        `${options.redisKeyPrefix}:{veilink:v1}:room:${ROOM_ID}`,
        JSON.stringify({ schemaVersion: 99, id: ROOM_ID }),
      )
      await expect(store.hasRoom(ROOM_ID)).rejects.toThrow('Unsupported Redis room record')
    } finally {
      client.destroy()
    }
  })

  it('keeps a vacant room when its final member leaves', async () => {
    const { store, owner } = await createHarness()
    await store.leave(owner.snapshot.roomId, owner.memberId, owner.sessionId)

    expect(await store.hasRoom(owner.snapshot.roomId)).toBe(true)
    expect(await store.snapshotById(owner.snapshot.roomId)).toBeUndefined()
  })

  it('removes a disconnected member after its Redis lease expires', async () => {
    const { store, owner } = await createHarness()
    await store.disconnect(owner.snapshot.roomId, owner.memberId, owner.sessionId)
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    await store.sweep()

    expect(await store.hasRoom(owner.snapshot.roomId)).toBe(true)
    expect(await store.snapshotById(owner.snapshot.roomId)).toBeUndefined()
  })

  it('makes the first member to join a vacant room its new owner', async () => {
    const { store, owner } = await createHarness()
    await store.leave(owner.snapshot.roomId, owner.memberId, owner.sessionId)

    const successor = await store.joinRoom({
      roomId: owner.snapshot.roomId,
      nickname: 'Successor',
      identityPublicKey: IDENTITY_B,
      transportId: 'transport-successor',
    })

    expect(successor.snapshot.ownerId).toBe(successor.memberId)
    expect(successor.snapshot.members).toHaveLength(1)
    expect(successor.snapshot.members[0]?.isOwner).toBe(true)
  })

  it('enforces member capacity under concurrent joins', async () => {
    const options = testRoomStoreOptions('concurrent-join', { maxMembers: 2 })
    const store = new RoomStore(options)
    await store.connect()
    harnesses.push({ store, prefix: options.redisKeyPrefix })
    await store.createRoom({
      roomId: ROOM_ID,
      admissionKey: ADMISSION_KEY,
      nickname: 'Owner',
      identityPublicKey: IDENTITY_A,
      transportId: 'transport-owner',
      publicIp: '203.0.113.1',
    })

    const joins = await Promise.allSettled([
      store.joinRoom({ roomId: ROOM_ID, nickname: 'First', identityPublicKey: IDENTITY_B, transportId: 'first' }),
      store.joinRoom({ roomId: ROOM_ID, nickname: 'Second', identityPublicKey: IDENTITY_C, transportId: 'second' }),
    ])
    expect(joins.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(joins.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect((await store.snapshotById(ROOM_ID))?.members).toHaveLength(2)
  })

  it('rotates the resume token and fences the replaced session', async () => {
    const { store, owner } = await createHarness()
    const events: RoomStoreEvent[] = []
    store.onEvent((event) => events.push(event))
    const resumed = await store.resumeRoom({
      roomId: owner.snapshot.roomId,
      memberId: owner.memberId,
      resumeToken: owner.resumeToken,
      identityPublicKey: IDENTITY_A,
      transportId: 'transport-owner-2',
    })
    expect(resumed.resumeToken).not.toBe(owner.resumeToken)
    expect(await store.authorize(owner.snapshot.roomId, owner.memberId, owner.sessionId)).toBe(false)
    expect(await store.authorize(owner.snapshot.roomId, owner.memberId, resumed.sessionId)).toBe(true)
    await expect(store.resumeRoom({
      roomId: owner.snapshot.roomId,
      memberId: owner.memberId,
      resumeToken: owner.resumeToken,
      identityPublicKey: IDENTITY_A,
      transportId: 'transport-owner-3',
    })).rejects.toEqual(new RoomStoreError('resume_rejected'))
    await vi.waitFor(() => {
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'session-replaced',
        sessionId: owner.sessionId,
      }))
    })
  })

  it('resumes the same member through a replacement store instance', async () => {
    const { store, owner, prefix } = await createHarness('restart-resume')
    await store.disconnect(owner.snapshot.roomId, owner.memberId, owner.sessionId)
    await store.close()

    const replacement = new RoomStore(testRoomStoreOptions('unused', {
      redisKeyPrefix: prefix,
    }))
    await replacement.connect()
    harnesses.push({ store: replacement, prefix })
    const resumed = await replacement.resumeRoom({
      roomId: owner.snapshot.roomId,
      memberId: owner.memberId,
      resumeToken: owner.resumeToken,
      identityPublicKey: IDENTITY_A,
      transportId: 'replacement-transport',
    })

    expect(resumed.memberId).toBe(owner.memberId)
    expect(resumed.snapshot.ownerId).toBe(owner.memberId)
    expect(await replacement.authorize(owner.snapshot.roomId, owner.memberId, resumed.sessionId)).toBe(true)
  })

  it('transfers ownership to the longest-present remaining member', async () => {
    const { store, owner } = await createHarness()
    const first = await store.joinRoom({
      roomId: owner.snapshot.roomId,
      nickname: 'First',
      identityPublicKey: IDENTITY_B,
      transportId: 'transport-first',
    })
    await store.joinRoom({
      roomId: owner.snapshot.roomId,
      nickname: 'Second',
      identityPublicKey: IDENTITY_C,
      transportId: 'transport-second',
    })

    await store.leave(owner.snapshot.roomId, owner.memberId, owner.sessionId)
    expect((await store.snapshotById(owner.snapshot.roomId))?.ownerId).toBe(first.memberId)
  })

  it('shares events and authoritative state across instances', async () => {
    const firstOptions = testRoomStoreOptions('multi-instance')
    const secondOptions = { ...firstOptions }
    const first = new RoomStore(firstOptions)
    const second = new RoomStore(secondOptions)
    await first.connect()
    await second.connect()
    harnesses.push({ store: first, prefix: firstOptions.redisKeyPrefix })
    harnesses.push({ store: second, prefix: firstOptions.redisKeyPrefix })
    const events: RoomStoreEvent[] = []
    second.onEvent((event) => events.push(event))
    const owner = await first.createRoom({
      roomId: ROOM_ID,
      admissionKey: ADMISSION_KEY,
      nickname: 'Owner',
      identityPublicKey: IDENTITY_A,
      transportId: 'transport-owner',
      publicIp: '203.0.113.1',
    })

    const peer = await second.joinRoom({
      roomId: owner.snapshot.roomId,
      nickname: 'Peer',
      identityPublicKey: IDENTITY_B,
      transportId: 'transport-peer',
    })

    await vi.waitFor(() => expect(events.some((event) =>
      event.kind === 'wire' && event.event.type === 'room.member.joined')).toBe(true))
    expect((await second.snapshotById(ROOM_ID))?.members).toHaveLength(2)

    await first.forwardRtcEvent({
      roomId: ROOM_ID,
      senderId: owner.memberId,
      sessionId: owner.sessionId,
      targetMemberId: peer.memberId,
      type: 'rtc.description',
      data: { type: 'offer', sdp: 'v=0' },
    })
    await vi.waitFor(() => expect(events.some((event) =>
      event.kind === 'wire' &&
      event.event.type === 'rtc.description' &&
      event.targetSessionId === peer.sessionId)).toBe(true))
  })

  it('expires room metadata using Redis TTL', async () => {
    const options = testRoomStoreOptions('room-expiry', { roomTtlMs: 250 })
    const store = new RoomStore(options)
    await store.connect()
    harnesses.push({ store, prefix: options.redisKeyPrefix })
    await store.createRoom({
      roomId: ROOM_ID,
      admissionKey: ADMISSION_KEY,
      nickname: 'Owner',
      identityPublicKey: IDENTITY_A,
      transportId: 'transport-owner',
      publicIp: '203.0.113.1',
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await store.sweep()
    expect(await store.hasRoom(ROOM_ID)).toBe(false)
  })

  it('verifies a Redis-backed one-time challenge', async () => {
    const { store, owner } = await createHarness()
    const challenge = await store.issueChallenge({
      roomId: owner.snapshot.roomId,
      transportId: 'peer',
      publicIp: '203.0.113.2',
      nickname: 'Peer',
      identityPublicKey: IDENTITY_B,
    })
    const proof = createAdmissionProof(ADMISSION_KEY, {
      roomId: owner.snapshot.roomId,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
    })
    await store.consumeChallenge({
      roomId: owner.snapshot.roomId,
      challengeId: challenge.challengeId,
      proof,
      transportId: 'peer',
      publicIp: '203.0.113.2',
      nickname: 'Peer',
      identityPublicKey: IDENTITY_B,
    })
    await expect(store.consumeChallenge({
      roomId: owner.snapshot.roomId,
      challengeId: challenge.challengeId,
      proof,
      transportId: 'peer',
      publicIp: '203.0.113.2',
      nickname: 'Peer',
      identityPublicKey: IDENTITY_B,
    })).rejects.toEqual(new RoomStoreError('challenge_rejected'))
  })
})

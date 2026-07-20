import { describe, expect, it } from 'vitest'
import { RoomSnapshotSchema } from '@veilink/protocol'

import { RoomStore, RoomStoreError, type WireEvent } from '../src/room-store.js'
import { createAdmissionProof } from '../src/security.js'

const ADMISSION_KEY = new Uint8Array(32).fill(7)
const IDENTITY_A = Buffer.alloc(32, 1).toString('base64url')
const IDENTITY_B = Buffer.alloc(32, 2).toString('base64url')
const IDENTITY_C = Buffer.alloc(32, 3).toString('base64url')

function createHarness() {
  let now = 1_000
  const events: WireEvent[] = []
  const store = new RoomStore({
    roomTtlMs: 60_000,
    disconnectGraceMs: 1_000,
    now: () => now,
  })
  const owner = store.createRoom({
    roomId: 'AAAAAAAAAAAAAAAAAAAAAA',
    admissionKey: ADMISSION_KEY,
    nickname: 'Owner',
    identityPublicKey: IDENTITY_A,
    transportId: 'transport-owner',
    sink: (event) => events.push(event),
  })
  return {
    store,
    owner,
    events,
    advance(milliseconds: number) {
      now += milliseconds
    },
  }
}

describe('RoomStore', () => {
  it('never stores server-observed IP addresses in room snapshots', () => {
    const { owner } = createHarness()
    expect(owner.snapshot.members[0]).not.toHaveProperty('publicIp')
    expect(RoomSnapshotSchema.safeParse(owner.snapshot).success).toBe(true)
  })

  it('destroys a room when its final member leaves', () => {
    const { store, owner } = createHarness()
    store.leave(owner.snapshot.roomId, owner.memberId, 'transport-owner')
    expect(store.size).toBe(0)
  })

  it('keeps a disconnected member only for the in-memory resume grace period', () => {
    const { store, owner, advance } = createHarness()
    store.disconnect(owner.snapshot.roomId, owner.memberId, 'transport-owner')
    expect(store.size).toBe(1)

    advance(999)
    store.sweep()
    expect(store.size).toBe(1)

    advance(1)
    store.sweep()
    expect(store.size).toBe(0)
  })

  it('rotates the resume token after a successful resume', () => {
    const { store, owner } = createHarness()
    store.disconnect(owner.snapshot.roomId, owner.memberId, 'transport-owner')
    const resumed = store.resumeRoom({
      roomId: owner.snapshot.roomId,
      memberId: owner.memberId,
      resumeToken: owner.resumeToken,
      identityPublicKey: IDENTITY_A,
      transportId: 'transport-owner-2',
      sink: () => undefined,
    })
    expect(resumed.resumeToken).not.toBe(owner.resumeToken)

    store.disconnect(owner.snapshot.roomId, owner.memberId, 'transport-owner-2')
    expect(() =>
      store.resumeRoom({
        roomId: owner.snapshot.roomId,
        memberId: owner.memberId,
        resumeToken: owner.resumeToken,
        identityPublicKey: IDENTITY_A,
        transportId: 'transport-owner-3',
        sink: () => undefined,
      }),
    ).toThrowError(new RoomStoreError('resume_rejected'))
  })

  it('transfers ownership to the longest-present remaining member', () => {
    const { store, owner, advance } = createHarness()
    advance(10)
    const first = store.joinRoom({
      roomId: owner.snapshot.roomId,
      nickname: 'First',
      identityPublicKey: IDENTITY_B,
      transportId: 'transport-first',
      sink: () => undefined,
    })
    advance(10)
    store.joinRoom({
      roomId: owner.snapshot.roomId,
      nickname: 'Second',
      identityPublicKey: IDENTITY_C,
      transportId: 'transport-second',
      sink: () => undefined,
    })

    store.leave(owner.snapshot.roomId, owner.memberId, 'transport-owner')
    expect(store.snapshotById(owner.snapshot.roomId)?.ownerId).toBe(first.memberId)
  })

  it('verifies a challenge-bound HMAC admission proof', () => {
    const { store, owner } = createHarness()
    const challenge = { challengeId: 'challenge', nonce: 'nonce' }
    const proof = createAdmissionProof(ADMISSION_KEY, {
      roomId: owner.snapshot.roomId,
      ...challenge,
    })
    expect(store.verifyAdmission(owner.snapshot.roomId, challenge, proof)).toBe(true)
    expect(store.verifyAdmission(owner.snapshot.roomId, challenge, `${proof.slice(0, -1)}A`)).toBe(false)
  })
})

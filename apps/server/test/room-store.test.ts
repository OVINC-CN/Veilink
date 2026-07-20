import { describe, expect, it } from 'vitest'
import { RoomSnapshotSchema, ServerSignalEnvelopeSchema } from '@veilink/protocol'

import { RoomStore, RoomStoreError, type WireEvent } from '../src/room-store.js'
import { createAdmissionProof } from '../src/security.js'

const ADMISSION_KEY = new Uint8Array(32).fill(7)
const IDENTITY_A = Buffer.alloc(32, 1).toString('base64url')
const IDENTITY_B = Buffer.alloc(32, 2).toString('base64url')
const IDENTITY_C = Buffer.alloc(32, 3).toString('base64url')

function createHarness(mode: 'p2p' | 'turn' = 'turn') {
  let now = 1_000
  const events: WireEvent[] = []
  const store = new RoomStore({
    roomTtlMs: 60_000,
    disconnectGraceMs: 1_000,
    modeSwitchTimeoutMs: 1_000,
    now: () => now,
  })
  const owner = store.createRoom({
    roomId: 'AAAAAAAAAAAAAAAAAAAAAA',
    admissionKey: ADMISSION_KEY,
    mode,
    nickname: 'Owner',
    identityPublicKey: IDENTITY_A,
    publicIp: '203.0.113.1',
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
  it('reveals server-observed IP addresses only in P2P mode', () => {
    const p2p = createHarness('p2p')
    expect(p2p.owner.snapshot.members[0]?.publicIp).toBe('203.0.113.1')
    expect(RoomSnapshotSchema.safeParse(p2p.owner.snapshot).success).toBe(true)

    const turn = createHarness('turn')
    expect(turn.owner.snapshot.members[0]).not.toHaveProperty('publicIp')
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
      publicIp: '203.0.113.9',
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
        publicIp: '203.0.113.9',
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
      publicIp: '203.0.113.2',
      transportId: 'transport-first',
      sink: () => undefined,
    })
    advance(10)
    store.joinRoom({
      roomId: owner.snapshot.roomId,
      nickname: 'Second',
      identityPublicKey: IDENTITY_C,
      publicIp: '203.0.113.3',
      transportId: 'transport-second',
      sink: () => undefined,
    })

    store.leave(owner.snapshot.roomId, owner.memberId, 'transport-owner')
    expect(store.snapshotById(owner.snapshot.roomId)?.ownerId).toBe(first.memberId)
  })

  it('commits a room-wide mode only after every member acknowledges', () => {
    const { store, owner, events } = createHarness('turn')
    const peer = store.joinRoom({
      roomId: owner.snapshot.roomId,
      nickname: 'Peer',
      identityPublicKey: IDENTITY_B,
      publicIp: '203.0.113.2',
      transportId: 'transport-peer',
      sink: () => undefined,
    })

    store.requestModeSwitch(owner.snapshot.roomId, owner.memberId, 'transport-owner', 'p2p', 1)
    store.acknowledgeModeSwitch(owner.snapshot.roomId, owner.memberId, 'transport-owner', 2, 'ready')
    expect(store.getRoomMode(owner.snapshot.roomId)).toEqual({ mode: 'turn', modeVersion: 1 })

    store.acknowledgeModeSwitch(owner.snapshot.roomId, peer.memberId, 'transport-peer', 2, 'ready')
    expect(store.getRoomMode(owner.snapshot.roomId)).toEqual({ mode: 'p2p', modeVersion: 2 })
    expect(store.snapshotById(owner.snapshot.roomId)?.members[0]).toHaveProperty('publicIp')
    for (const event of events) {
      expect(
        ServerSignalEnvelopeSchema.safeParse({ ...event, roomId: owner.snapshot.roomId }).success,
      ).toBe(true)
    }
  })

  it('evicts non-acknowledging members when the mode switch deadline passes', () => {
    const { store, owner, advance } = createHarness('turn')
    const peer = store.joinRoom({
      roomId: owner.snapshot.roomId,
      nickname: 'Peer',
      identityPublicKey: IDENTITY_B,
      publicIp: '203.0.113.2',
      transportId: 'transport-peer',
      sink: () => undefined,
    })
    store.requestModeSwitch(owner.snapshot.roomId, owner.memberId, 'transport-owner', 'p2p', 1)
    store.acknowledgeModeSwitch(owner.snapshot.roomId, owner.memberId, 'transport-owner', 2, 'ready')

    advance(1_000)
    store.sweep()
    const snapshot = store.snapshotById(owner.snapshot.roomId)
    expect(snapshot?.mode).toBe('p2p')
    expect(snapshot?.members.map((member) => member.memberId)).not.toContain(peer.memberId)
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

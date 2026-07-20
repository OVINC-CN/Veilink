import { describe, expect, it } from 'vitest'

import { AdmissionError, AdmissionService } from '../src/admission.js'
import { AdmissionRateLimiter } from '../src/rate-limit.js'
import { RoomStore } from '../src/room-store.js'
import { createAdmissionProof } from '../src/security.js'

describe('AdmissionService', () => {
  it('binds one-time challenges to room, transport and observed IP', () => {
    let now = 1_000
    const key = new Uint8Array(32).fill(3)
    const store = new RoomStore({ roomTtlMs: 60_000, now: () => now })
    const session = store.createRoom({
      roomId: 'AAAAAAAAAAAAAAAAAAAAAA',
      admissionKey: key,
      nickname: 'Owner',
      identityPublicKey: Buffer.alloc(32, 1).toString('base64url'),
      transportId: 'owner',
      sink: () => undefined,
    })
    const admission = new AdmissionService({ roomStore: store, now: () => now })
    const challenge = admission.issue(
      session.snapshot.roomId,
      'peer',
      '203.0.113.2',
      'Peer',
      Buffer.alloc(32, 1).toString('base64url'),
    )
    const proof = createAdmissionProof(key, {
      roomId: session.snapshot.roomId,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
    })

    expect(() =>
      admission.verify({
        roomId: session.snapshot.roomId,
        challengeId: challenge.challengeId,
        proof,
        transportId: 'peer',
        publicIp: '203.0.113.2',
        nickname: 'Peer',
        identityPublicKey: Buffer.alloc(32, 1).toString('base64url'),
      }),
    ).not.toThrow()
    expect(() =>
      admission.verify({
        roomId: session.snapshot.roomId,
        challengeId: challenge.challengeId,
        proof,
        transportId: 'peer',
        publicIp: '203.0.113.2',
        nickname: 'Peer',
        identityPublicKey: Buffer.alloc(32, 1).toString('base64url'),
      }),
    ).toThrowError(new AdmissionError('challenge_rejected'))
    now += 1
  })

  it('rate limits repeated failed proofs per IP and room', () => {
    let now = 1_000
    const limiter = new AdmissionRateLimiter({
      now: () => now,
      maxPerIpAndRoom: 2,
      maxPerRoom: 10,
    })
    expect(limiter.canAttempt('room', '203.0.113.2')).toBe(true)
    limiter.recordFailure('room', '203.0.113.2')
    limiter.recordFailure('room', '203.0.113.2')
    expect(limiter.canAttempt('room', '203.0.113.2')).toBe(false)

    now += 10 * 60 * 1_000
    expect(limiter.canAttempt('room', '203.0.113.2')).toBe(true)
  })
})

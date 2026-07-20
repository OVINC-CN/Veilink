import { afterEach, describe, expect, it } from 'vitest'

import { AdmissionError, AdmissionService } from '../src/admission.js'
import { RoomStore } from '../src/room-store.js'
import { createAdmissionProof } from '../src/security.js'
import { clearRedisPrefix, testRoomStoreOptions } from './redis-test.js'

const stores: Array<{ store: RoomStore; prefix: string }> = []

afterEach(async () => {
  const active = stores.splice(0)
  await Promise.all(active.map(async ({ store, prefix }) => {
    await store.close()
    await clearRedisPrefix(prefix)
  }))
})

describe('Redis AdmissionService', () => {
  it('binds one-time challenges to room, transport and HMAC-obscured IP', async () => {
    const options = testRoomStoreOptions('admission')
    const store = new RoomStore(options)
    await store.connect()
    stores.push({ store, prefix: options.redisKeyPrefix })
    const key = new Uint8Array(32).fill(3)
    const session = await store.createRoom({
      roomId: 'AAAAAAAAAAAAAAAAAAAAAA',
      admissionKey: key,
      nickname: 'Owner',
      identityPublicKey: Buffer.alloc(32, 1).toString('base64url'),
      transportId: 'owner',
      publicIp: '203.0.113.1',
    })
    const admission = new AdmissionService({ roomStore: store })
    const challenge = await admission.issue(
      session.snapshot.roomId,
      'peer',
      '203.0.113.2',
      'Peer',
      Buffer.alloc(32, 2).toString('base64url'),
    )
    const proof = createAdmissionProof(key, {
      roomId: session.snapshot.roomId,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
    })

    await expect(admission.verify({
      roomId: session.snapshot.roomId,
      challengeId: challenge.challengeId,
      proof,
      transportId: 'peer',
      publicIp: '203.0.113.2',
      nickname: 'Peer',
      identityPublicKey: Buffer.alloc(32, 2).toString('base64url'),
    })).resolves.toBeUndefined()
    await expect(admission.verify({
      roomId: session.snapshot.roomId,
      challengeId: challenge.challengeId,
      proof,
      transportId: 'peer',
      publicIp: '203.0.113.2',
      nickname: 'Peer',
      identityPublicKey: Buffer.alloc(32, 2).toString('base64url'),
    })).rejects.toEqual(new AdmissionError('challenge_rejected'))
  })
})

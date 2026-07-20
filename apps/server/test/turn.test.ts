import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { isRtcCandidateAllowed, isRtcDescriptionAllowed } from '../src/rtc-policy.js'
import { createTurnCredential } from '../src/turn.js'

describe('TURN credentials and relay policy', () => {
  it('creates coturn REST HMAC credentials with a bounded expiry', () => {
    const credential = createTurnCredential({
      memberId: 'member',
      urls: ['turn:turn.example:3478'],
      sharedSecret: 'a-secret-that-is-long-enough-for-testing',
      ttlSeconds: 3_600,
      now: 1_000_000,
    })
    expect(credential.username).toBe('4600:member')
    expect(credential.credential).toBe(
      createHmac('sha1', 'a-secret-that-is-long-enough-for-testing')
        .update(credential.username)
        .digest('base64'),
    )
  })

  it('allows only relay candidates in TURN mode and rejects relay in P2P mode', () => {
    const relay = 'candidate:1 1 UDP 1 192.0.2.1 49152 typ relay raddr 0.0.0.0 rport 0'
    const host = 'candidate:2 1 UDP 1 10.0.0.4 49153 typ host'
    expect(isRtcCandidateAllowed(relay, 'turn')).toBe(true)
    expect(isRtcCandidateAllowed(host, 'turn')).toBe(false)
    expect(isRtcCandidateAllowed(relay, 'p2p')).toBe(false)
    expect(isRtcCandidateAllowed(host, 'p2p')).toBe(true)

    expect(isRtcDescriptionAllowed(`v=0\r\na=${relay}\r\n`, 'turn')).toBe(true)
    expect(isRtcDescriptionAllowed(`v=0\r\na=${host}\r\n`, 'turn')).toBe(false)
  })
})

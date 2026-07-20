import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { isRtcCandidateAllowed } from '../src/rtc-policy.js'

describe('deployment and RTC security policy', () => {
  it('fails closed on an insecure production origin', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production',
      APP_ORIGIN: 'http://veilink.example',
    })).toThrow('must use HTTPS')
  })

  it('rejects malformed candidates and duplicate type tokens', () => {
    const smuggledRelay = 'candidate:1 1 udp 1 203.0.113.2 3478 typ host typ relay'
    expect(isRtcCandidateAllowed(smuggledRelay)).toBe(false)
    expect(isRtcCandidateAllowed('candidate:not-a-valid-candidate typ relay')).toBe(false)
  })

  it('requires TURN configuration in every environment', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow('TURN_REST_SECRET is required')
    expect(() => loadConfig({
      NODE_ENV: 'test',
      TURN_REST_SECRET: 'a-production-grade-turn-secret-value',
    })).toThrow('TURN_URLS is required')
  })
})

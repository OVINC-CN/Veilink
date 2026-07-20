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
    expect(isRtcCandidateAllowed(smuggledRelay, 'turn')).toBe(false)
    expect(isRtcCandidateAllowed('candidate:not-a-valid-candidate typ relay', 'turn')).toBe(false)
  })
})

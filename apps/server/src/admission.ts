import { AdmissionRateLimiter } from './rate-limit.js'
import { randomId } from './security.js'
import type { RoomStore } from './room-store.js'

interface Challenge {
  id: string
  nonce: string
  roomId: string
  transportId: string
  publicIp: string
  nickname: string
  identityPublicKey: string
  expiresAt: number
}

export type AdmissionErrorCode =
  | 'room_not_found'
  | 'rate_limited'
  | 'challenge_rejected'
  | 'admission_failed'

export class AdmissionError extends Error {
  constructor(readonly code: AdmissionErrorCode) {
    super(code)
    this.name = 'AdmissionError'
  }
}

export interface AdmissionServiceOptions {
  roomStore: RoomStore
  challengeTtlMs?: number
  maxChallenges?: number
  now?: () => number
  rateLimiter?: AdmissionRateLimiter
}

export class AdmissionService {
  readonly #roomStore: RoomStore
  readonly #challengeTtlMs: number
  readonly #maxChallenges: number
  readonly #now: () => number
  readonly #rateLimiter: AdmissionRateLimiter
  readonly #challenges = new Map<string, Challenge>()
  readonly #challengeByTransport = new Map<string, string>()

  constructor(options: AdmissionServiceOptions) {
    this.#roomStore = options.roomStore
    this.#challengeTtlMs = options.challengeTtlMs ?? 30_000
    this.#maxChallenges = options.maxChallenges ?? 4_096
    this.#now = options.now ?? Date.now
    this.#rateLimiter = options.rateLimiter ?? new AdmissionRateLimiter({ now: this.#now })
  }

  issue(
    roomId: string,
    transportId: string,
    publicIp: string,
    nickname: string,
    identityPublicKey: string,
  ): {
    challengeId: string
    nonce: string
    expiresAt: number
  } {
    if (!this.#roomStore.hasRoom(roomId)) throw new AdmissionError('room_not_found')
    if (!this.#rateLimiter.canAttempt(roomId, publicIp)) throw new AdmissionError('rate_limited')
    this.sweep()
    if (this.#challenges.size >= this.#maxChallenges) throw new AdmissionError('rate_limited')

    this.removeForTransport(transportId)
    const challenge: Challenge = {
      id: randomId(16),
      nonce: randomId(32),
      roomId,
      transportId,
      publicIp,
      nickname,
      identityPublicKey,
      expiresAt: this.#now() + this.#challengeTtlMs,
    }
    this.#challenges.set(challenge.id, challenge)
    this.#challengeByTransport.set(transportId, challenge.id)
    return {
      challengeId: challenge.id,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
    }
  }

  verify(input: {
    roomId: string
    challengeId: string
    proof: string
    transportId: string
    publicIp: string
    nickname: string
    identityPublicKey: string
  }): void {
    if (!this.#rateLimiter.canAttempt(input.roomId, input.publicIp)) {
      throw new AdmissionError('rate_limited')
    }
    const challenge = this.#challenges.get(input.challengeId)
    this.#deleteChallenge(input.challengeId)
    if (
      challenge === undefined ||
      challenge.expiresAt <= this.#now() ||
      challenge.roomId !== input.roomId ||
      challenge.transportId !== input.transportId ||
      challenge.publicIp !== input.publicIp
      || challenge.nickname !== input.nickname
      || challenge.identityPublicKey !== input.identityPublicKey
    ) {
      this.#rateLimiter.recordFailure(input.roomId, input.publicIp)
      throw new AdmissionError('challenge_rejected')
    }
    const verified = this.#roomStore.verifyAdmission(
      input.roomId,
      { challengeId: challenge.id, nonce: challenge.nonce },
      input.proof,
    )
    if (!verified) {
      this.#rateLimiter.recordFailure(input.roomId, input.publicIp)
      throw new AdmissionError('admission_failed')
    }
  }

  removeForTransport(transportId: string): void {
    const challengeId = this.#challengeByTransport.get(transportId)
    if (challengeId !== undefined) this.#deleteChallenge(challengeId)
  }

  clearRoom(roomId: string): void {
    for (const [challengeId, challenge] of this.#challenges) {
      if (challenge.roomId === roomId) this.#deleteChallenge(challengeId)
    }
    this.#rateLimiter.clearRoom(roomId)
  }

  sweep(): void {
    const now = this.#now()
    for (const [challengeId, challenge] of this.#challenges) {
      if (challenge.expiresAt <= now) this.#deleteChallenge(challengeId)
    }
    this.#rateLimiter.sweep()
  }

  #deleteChallenge(challengeId: string): void {
    const challenge = this.#challenges.get(challengeId)
    if (challenge !== undefined) {
      this.#challenges.delete(challengeId)
      if (this.#challengeByTransport.get(challenge.transportId) === challengeId) {
        this.#challengeByTransport.delete(challenge.transportId)
      }
    }
  }
}

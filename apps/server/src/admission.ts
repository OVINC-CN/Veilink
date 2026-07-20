import { RoomStore, RoomStoreError } from './room-store.js'

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
}

function mapError(error: unknown): never {
  if (error instanceof RoomStoreError) {
    if (
      error.code === 'room_not_found' ||
      error.code === 'rate_limited' ||
      error.code === 'challenge_rejected' ||
      error.code === 'admission_failed'
    ) {
      throw new AdmissionError(error.code)
    }
  }
  throw error
}

export class AdmissionService {
  readonly #roomStore: RoomStore

  constructor(options: AdmissionServiceOptions) {
    this.#roomStore = options.roomStore
  }

  async issue(
    roomId: string,
    transportId: string,
    publicIp: string,
    nickname: string,
    identityPublicKey: string,
  ): Promise<{ challengeId: string; nonce: string; expiresAt: number }> {
    try {
      return await this.#roomStore.issueChallenge({
        roomId,
        transportId,
        publicIp,
        nickname,
        identityPublicKey,
      })
    } catch (error) {
      return mapError(error)
    }
  }

  async verify(input: {
    roomId: string
    challengeId: string
    proof: string
    transportId: string
    publicIp: string
    nickname: string
    identityPublicKey: string
  }): Promise<void> {
    try {
      await this.#roomStore.consumeChallenge(input)
    } catch (error) {
      mapError(error)
    }
  }
}

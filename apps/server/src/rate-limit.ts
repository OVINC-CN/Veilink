interface Counter {
  count: number
  resetAt: number
}

export interface AdmissionRateLimitOptions {
  windowMs?: number
  maxPerIpAndRoom?: number
  maxPerRoom?: number
  now?: () => number
}

export class AdmissionRateLimiter {
  readonly #windowMs: number
  readonly #maxPerIpAndRoom: number
  readonly #maxPerRoom: number
  readonly #now: () => number
  readonly #byIpAndRoom = new Map<string, Counter>()
  readonly #byRoom = new Map<string, Counter>()

  constructor(options: AdmissionRateLimitOptions = {}) {
    this.#windowMs = options.windowMs ?? 10 * 60 * 1_000
    this.#maxPerIpAndRoom = options.maxPerIpAndRoom ?? 5
    this.#maxPerRoom = options.maxPerRoom ?? 30
    this.#now = options.now ?? Date.now
  }

  canAttempt(roomId: string, ip: string): boolean {
    const now = this.#now()
    const pair = this.#getLive(this.#byIpAndRoom, this.#pairKey(roomId, ip), now)
    const room = this.#getLive(this.#byRoom, roomId, now)
    return (pair?.count ?? 0) < this.#maxPerIpAndRoom && (room?.count ?? 0) < this.#maxPerRoom
  }

  recordFailure(roomId: string, ip: string): void {
    const now = this.#now()
    this.#increment(this.#byIpAndRoom, this.#pairKey(roomId, ip), now)
    this.#increment(this.#byRoom, roomId, now)
  }

  clearRoom(roomId: string): void {
    this.#byRoom.delete(roomId)
    const prefix = `${roomId}\u0000`
    for (const key of this.#byIpAndRoom.keys()) {
      if (key.startsWith(prefix)) this.#byIpAndRoom.delete(key)
    }
  }

  sweep(): void {
    const now = this.#now()
    this.#sweepMap(this.#byIpAndRoom, now)
    this.#sweepMap(this.#byRoom, now)
  }

  #pairKey(roomId: string, ip: string): string {
    return `${roomId}\u0000${ip}`
  }

  #increment(map: Map<string, Counter>, key: string, now: number): void {
    const current = this.#getLive(map, key, now)
    if (current === undefined) {
      map.set(key, { count: 1, resetAt: now + this.#windowMs })
      return
    }
    current.count += 1
  }

  #getLive(map: Map<string, Counter>, key: string, now: number): Counter | undefined {
    const counter = map.get(key)
    if (counter !== undefined && counter.resetAt <= now) {
      map.delete(key)
      return undefined
    }
    return counter
  }

  #sweepMap(map: Map<string, Counter>, now: number): void {
    for (const [key, counter] of map) {
      if (counter.resetAt <= now) map.delete(key)
    }
  }
}

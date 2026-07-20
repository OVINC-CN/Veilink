import { randomUUID } from 'node:crypto'

import { createClient } from 'redis'

import type { RoomStoreOptions } from '../src/room-store.js'

export function testRedisUrl(): string {
  const url = process.env.REDIS_URL
  if (!url) throw new Error('REDIS_URL is required to run the server test suite')
  return url
}

export function testRedisPrefix(label: string): string {
  return `veilink:test:${label}:${process.pid}:${randomUUID().replaceAll('-', '')}`
}

export function testRoomStoreOptions(
  label: string,
  overrides: Partial<RoomStoreOptions> = {},
): RoomStoreOptions {
  return {
    redisUrl: testRedisUrl(),
    redisKeyPrefix: testRedisPrefix(label),
    roomTtlMs: 60_000,
    disconnectGraceMs: 1_000,
    heartbeatIntervalMs: 250,
    ipHashSecret: 'a-test-secret-that-is-shared-by-all-test-instances',
    ...overrides,
  }
}

export async function clearRedisPrefix(prefix: string): Promise<void> {
  const client = createClient({ url: testRedisUrl() })
  await client.connect()
  try {
    for await (const keys of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) {
      if (keys.length > 0) await client.unlink(keys)
    }
  } finally {
    client.destroy()
  }
}

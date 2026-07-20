import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'

import { PROTOCOL_VERSION } from '@veilink/protocol'

export const MAX_ROOM_TTL_MS = 24 * 60 * 60 * 1_000

export interface ServerConfig {
  host: string
  port: number
  appOrigin?: string
  tlsCertFile?: string
  tlsKeyFile?: string
  roomTtlMs: number
  maxRooms: number
  maxConnections: number
  maxConnectionsPerIp: number
  maxRoomsPerIp: number
  roomCreateAttemptsPerMinute: number
  maxMembers: number
  heartbeatIntervalMs: number
  disconnectGraceMs: number
  challengeTtlMs: number
  trustProxy: false | string[]
  staticRoot: string
  turnUrls: string[]
  turnRestSecret: string
  turnCredentialTtlSeconds: number
}

export interface PublicConfig {
  protocolVersion: typeof PROTOCOL_VERSION
  limits: {
    maxMembers: number
    maxRoomTtlMs: number
    roomTtlMs: number
    maxFileSizeMb: number
  }
  heartbeatIntervalMs: number
  disconnectGraceMs: number
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === '') return fallback
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`)
  }
  return parsed
}

function parseRequiredUrlList(
  value: string | undefined,
  name: string,
  allowedSchemes: readonly string[],
): string[] {
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`)
  const urls = value
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
  if (urls.length === 0) throw new Error(`${name} is required`)
  for (const url of urls) {
    const separator = url.indexOf(':')
    const scheme = separator === -1 ? '' : url.slice(0, separator)
    if (!allowedSchemes.includes(scheme) || separator === url.length - 1 || /\s/u.test(url)) {
      throw new Error(`Invalid ICE server URL: ${url}`)
    }
  }
  return urls
}

function parseTrustProxy(value: string | undefined): false | string[] {
  if (value === undefined || value.trim() === '') return false
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  if (entries.length === 0) return false
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split('/')
    const family = address === undefined ? 0 : isIP(address)
    if (family === 0 || extra !== undefined) {
      throw new Error('TRUST_PROXY_CIDRS must contain only explicit IP addresses or CIDRs')
    }
    if (prefix !== undefined) {
      if (!/^\d+$/.test(prefix)) throw new Error(`Invalid proxy CIDR: ${entry}`)
      const bits = Number(prefix)
      const maximum = family === 4 ? 32 : 128
      if (bits < 0 || bits > maximum) throw new Error(`Invalid proxy CIDR: ${entry}`)
    }
  }
  return entries
}

function parseAppOrigin(value: string | undefined, production: boolean): string | undefined {
  if (value === undefined || value.trim() === '') {
    if (production) throw new Error('APP_ORIGIN is required in production')
    return undefined
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('APP_ORIGIN must be an absolute HTTP(S) origin')
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    value !== url.origin
  ) {
    throw new Error('APP_ORIGIN must be an exact HTTP(S) origin without a trailing slash')
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error('APP_ORIGIN must use HTTPS outside local development')
  }
  return url.origin
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const appOrigin = parseAppOrigin(env.APP_ORIGIN, env.NODE_ENV === 'production')
  const tlsCertFile = env.TLS_CERT_FILE?.trim()
  const tlsKeyFile = env.TLS_KEY_FILE?.trim()
  if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
    throw new Error('TLS_CERT_FILE and TLS_KEY_FILE must be configured together')
  }
  const roomTtlSeconds = parseInteger(
    env.ROOM_TTL_SECONDS,
    MAX_ROOM_TTL_MS / 1_000,
    'ROOM_TTL_SECONDS',
    60,
    MAX_ROOM_TTL_MS / 1_000,
  )
  const turnRestSecret = env.TURN_REST_SECRET?.trim()
  if (!turnRestSecret) throw new Error('TURN_REST_SECRET is required')
  if (turnRestSecret.length < 32) {
    throw new Error('TURN_REST_SECRET must contain at least 32 characters')
  }

  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port: parseInteger(env.PORT, 3_000, 'PORT', 1, 65_535),
    ...(appOrigin === undefined ? {} : { appOrigin }),
    ...(tlsCertFile ? { tlsCertFile } : {}),
    ...(tlsKeyFile ? { tlsKeyFile } : {}),
    roomTtlMs: roomTtlSeconds * 1_000,
    maxRooms: parseInteger(env.MAX_ROOMS, 1_000, 'MAX_ROOMS', 1, 100_000),
    maxConnections: parseInteger(env.MAX_CONNECTIONS, 2_048, 'MAX_CONNECTIONS', 1, 100_000),
    maxConnectionsPerIp: parseInteger(env.MAX_CONNECTIONS_PER_IP, 64, 'MAX_CONNECTIONS_PER_IP', 1, 10_000),
    maxRoomsPerIp: parseInteger(env.MAX_ROOMS_PER_IP, 32, 'MAX_ROOMS_PER_IP', 1, 10_000),
    roomCreateAttemptsPerMinute: parseInteger(
      env.ROOM_CREATE_ATTEMPTS_PER_MINUTE,
      20,
      'ROOM_CREATE_ATTEMPTS_PER_MINUTE',
      1,
      10_000,
    ),
    maxMembers: 8,
    heartbeatIntervalMs: 15_000,
    disconnectGraceMs: 30_000,
    challengeTtlMs: 30_000,
    trustProxy: parseTrustProxy(env.TRUST_PROXY_CIDRS),
    staticRoot:
      env.WEB_DIST_DIR?.trim() || fileURLToPath(new URL('../../web/dist/', import.meta.url)),
    turnUrls: parseRequiredUrlList(
      env.TURN_URLS,
      'TURN_URLS',
      ['turn', 'turns'],
    ),
    turnRestSecret,
    turnCredentialTtlSeconds: parseInteger(
      env.TURN_CREDENTIAL_TTL_SECONDS,
      600,
      'TURN_CREDENTIAL_TTL_SECONDS',
      300,
      600,
    ),
  }
}

export function getPublicConfig(config: ServerConfig): PublicConfig {
  return {
    protocolVersion: PROTOCOL_VERSION,
    limits: {
      maxMembers: config.maxMembers,
      maxRoomTtlMs: MAX_ROOM_TTL_MS,
      roomTtlMs: config.roomTtlMs,
      maxFileSizeMb: 256,
    },
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    disconnectGraceMs: config.disconnectGraceMs,
  }
}

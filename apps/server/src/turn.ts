import { createHmac } from 'node:crypto'

export interface TurnCredential {
  urls: string[]
  username: string
  credential: string
  credentialType: 'password'
  expiresAt: number
}

export function createTurnCredential(input: {
  memberId: string
  urls: string[]
  sharedSecret: string
  ttlSeconds: number
  now?: number
}): TurnCredential {
  const now = input.now ?? Date.now()
  const expiresAtSeconds = Math.floor(now / 1_000) + input.ttlSeconds
  const username = `${expiresAtSeconds}:${input.memberId}`
  const credential = createHmac('sha1', input.sharedSecret).update(username).digest('base64')
  return {
    urls: [...input.urls],
    username,
    credential,
    credentialType: 'password',
    expiresAt: expiresAtSeconds * 1_000,
  }
}

/// <reference lib="webworker" />

import sodium from 'libsodium-wrappers-sumo'
import { RoomIdSchema, encodeHkdfInfo } from '@veilink/protocol'
import { base64UrlToBytes, concatBytes } from '../lib/encoding'

interface DeriveRequest {
  pin: string
  roomId: string
  linkSecret: string
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array): Promise<Uint8Array> {
  const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    return copy.buffer
  }
  const material = await crypto.subtle.importKey('raw', toArrayBuffer(ikm), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(info),
    },
    material,
    256,
  )
  return new Uint8Array(bits)
}

self.addEventListener('message', (event: MessageEvent<DeriveRequest>) => {
  void (async () => {
      const { pin, roomId, linkSecret } = event.data
    try {
      await sodium.ready
      const salt = base64UrlToBytes(roomId)
      const parsedRoomId = RoomIdSchema.parse(roomId)
      const secret = base64UrlToBytes(linkSecret)
      if (!/^\d{6}$/u.test(pin) || salt.length !== 16 || secret.length !== 32) {
        throw new Error('Invalid key material')
      }

      const pinKey = sodium.crypto_pwhash(
        32,
        pin,
        salt,
        3,
        64 * 1024 * 1024,
        sodium.crypto_pwhash_ALG_ARGON2ID13,
      )
      const rootInput = concatBytes(pinKey, secret)
      const root = await hkdf(rootInput, salt, new TextEncoder().encode(`veilink/v1/root\0${parsedRoomId}`))
      const admissionKey = await hkdf(root, salt, encodeHkdfInfo('admission', parsedRoomId))
      const messageKey = await hkdf(root, salt, encodeHkdfInfo('message', parsedRoomId))
      const fileKey = await hkdf(root, salt, encodeHkdfInfo('file', parsedRoomId))
      const fingerprintKey = await hkdf(root, salt, encodeHkdfInfo('fingerprint', parsedRoomId))
      const fingerprintBytes = sodium.crypto_generichash(16, fingerprintKey, null)
      const fingerprintHex = sodium.to_hex(fingerprintBytes).toUpperCase()
      const fingerprint = fingerprintHex.match(/.{1,4}/gu)?.join(' ') ?? fingerprintHex

      self.postMessage({
        ok: true,
        keys: {
          admissionKey,
          messageKey,
          fileKey,
          fingerprintKey,
          fingerprint,
        },
      }, [admissionKey.buffer, messageKey.buffer, fileKey.buffer, fingerprintKey.buffer])

      sodium.memzero(pinKey)
      sodium.memzero(secret)
      sodium.memzero(rootInput)
      sodium.memzero(root)
    } catch (error) {
      self.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Key derivation failed' })
    }
  })()
})

export {}

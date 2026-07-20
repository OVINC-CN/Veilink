import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/u

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('base64url')
}

export function decodeKey(value: string): Buffer | undefined {
  if (!BASE64URL_32_PATTERN.test(value)) return undefined
  const key = Buffer.from(value, 'base64url')
  return key.byteLength === 32 ? key : undefined
}

export function hashResumeToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

export function safeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

export function admissionProofMessage(input: {
  roomId: string
  challengeId: string
  nonce: string
}): Buffer {
  return Buffer.from(
    `veilink/v1/admission-proof\u0000${input.roomId}\u0000${input.challengeId}\u0000${input.nonce}`,
    'utf8',
  )
}

export function createAdmissionProof(
  admissionKey: Uint8Array,
  input: { roomId: string; challengeId: string; nonce: string },
): string {
  return createHmac('sha256', admissionKey)
    .update(admissionProofMessage(input))
    .digest('base64url')
}

export function verifyAdmissionProof(
  admissionKey: Uint8Array,
  input: { roomId: string; challengeId: string; nonce: string },
  encodedProof: string,
): boolean {
  const proof = decodeKey(encodedProof)
  if (proof === undefined) return false
  const expected = createHmac('sha256', admissionKey)
    .update(admissionProofMessage(input))
    .digest()
  return safeEqual(expected, proof)
}

export function sanitizePublicIp(value: string): string {
  const zoneIndex = value.indexOf('%')
  return zoneIndex === -1 ? value : value.slice(0, zoneIndex)
}

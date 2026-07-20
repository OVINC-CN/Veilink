export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const output = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index)
  }
  return output
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

export function randomId(length = 16): string {
  return bytesToBase64Url(randomBytes(length))
}

export function randomPin(): string {
  const limit = 0x1_0000_0000 - (0x1_0000_0000 % 1_000_000)
  const value = new Uint32Array(1)
  do {
    crypto.getRandomValues(value)
  } while ((value[0] ?? limit) >= limit)
  return String((value[0] ?? 0) % 1_000_000).padStart(6, '0')
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(arrays.reduce((total, item) => total + item.length, 0))
  let offset = 0
  for (const item of arrays) {
    output.set(item, offset)
    offset += item.length
  }
  return output
}

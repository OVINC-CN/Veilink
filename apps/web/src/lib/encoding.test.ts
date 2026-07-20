import { generatePin } from '@veilink/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  base64UrlToBytes,
  bytesToBase64Url,
  randomPin,
} from './encoding'

describe('browser-safe encoding', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('round-trips arbitrary bytes with canonical unpadded base64url', () => {
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 253, 254, 255])
    const encoded = bytesToBase64Url(bytes)

    expect(encoded).toBe('AAECf4D9_v8')
    expect(encoded).not.toMatch(/[+/=]/u)
    expect(base64UrlToBytes(encoded)).toEqual(bytes)
  })

  it('generates exactly six decimal digits', () => {
    for (let index = 0; index < 128; index += 1) {
      expect(generatePin()).toMatch(/^\d{6}$/u)
      expect(randomPin()).toMatch(/^\d{6}$/u)
    }
  })

  it('keeps leading zeroes in a generated PIN', () => {
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
      if (array instanceof Uint32Array) array[0] = 42
      return array
    })

    expect(randomPin()).toBe('000042')
  })
})

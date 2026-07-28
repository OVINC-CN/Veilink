// @vitest-environment node

import { describe, expect, it } from 'vitest'

import {
  AttachmentIdSchema,
  DIGEST_BYTES,
  FILE_CHUNK_SIZE_BYTES,
  MAX_FILE_CHUNK_FRAME_BYTES,
  PROTOCOL_VERSION,
  base64UrlEncode,
  decodeFileChunk,
  encodeFileChunk,
  inspectFileChunk,
} from './index.js'

const attachmentId = AttachmentIdSchema.parse(base64UrlEncode(new Uint8Array(16).fill(11)))

describe('binary file chunk frames', () => {
  it('encodes the maximum final frame within the negotiated message boundary', () => {
    const wire = encodeFileChunk({
      attachmentId,
      chunkIndex: 7,
      final: true,
      ciphertext: new Uint8Array(FILE_CHUNK_SIZE_BYTES + 17),
      digest: new Uint8Array(DIGEST_BYTES).fill(3),
    })

    expect(PROTOCOL_VERSION).toBe(10)
    expect(FILE_CHUNK_SIZE_BYTES).toBe(240 * 1024)
    expect(wire.byteLength).toBe(MAX_FILE_CHUNK_FRAME_BYTES)
    expect(inspectFileChunk(wire)).toEqual({
      attachmentId,
      chunkIndex: 7,
      final: true,
      byteLength: MAX_FILE_CHUNK_FRAME_BYTES,
    })
  })

  it('decodes ciphertext and digest as views of the transferred frame', () => {
    const wire = encodeFileChunk({
      attachmentId,
      chunkIndex: 0,
      final: true,
      ciphertext: new Uint8Array(17).fill(5),
      digest: new Uint8Array(DIGEST_BYTES).fill(9),
    })

    const decoded = decodeFileChunk(wire)
    expect(decoded.ciphertext.buffer).toBe(wire)
    expect(decoded.digest?.buffer).toBe(wire)
    expect(decoded.ciphertext).toEqual(new Uint8Array(17).fill(5))
    expect(decoded.digest).toEqual(new Uint8Array(DIGEST_BYTES).fill(9))
  })

  it('rejects invalid routing flags before exposing frame metadata', () => {
    const wire = encodeFileChunk({
      attachmentId,
      chunkIndex: 0,
      final: false,
      ciphertext: new Uint8Array(17),
    })
    new Uint8Array(wire)[22] = 0x80

    expect(() => inspectFileChunk(wire)).toThrow('flags are invalid')
  })
})

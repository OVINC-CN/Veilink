import {
  DIGEST_BYTES,
  FILE_CHUNK_SIZE_BYTES,
  MEMBER_ID_BYTES,
  PROTOCOL_VERSION,
} from './constants.js'
import { base64UrlDecode, base64UrlEncode } from './encoding.js'
import type { AttachmentId } from './primitives.js'

const FILE_CHUNK_FRAME_TYPE = 1
const FINAL_FLAG = 1
const FIXED_HEADER_BYTES = 1 + 1 + MEMBER_ID_BYTES + 4 + 1
const SECRETSTREAM_OVERHEAD_BYTES = 17

export interface BinaryFileChunk {
  attachmentId: AttachmentId
  chunkIndex: number
  final: boolean
  ciphertext: Uint8Array
  digest?: Uint8Array
}

export function encodeFileChunk(frame: BinaryFileChunk): ArrayBuffer {
  const attachmentId = base64UrlDecode(frame.attachmentId)
  if (attachmentId.byteLength !== MEMBER_ID_BYTES) throw new Error('Invalid attachment ID')
  if (!Number.isSafeInteger(frame.chunkIndex) || frame.chunkIndex < 0 || frame.chunkIndex > 0xffff_ffff) {
    throw new Error('Invalid file chunk index')
  }
  if (frame.ciphertext.byteLength < SECRETSTREAM_OVERHEAD_BYTES || frame.ciphertext.byteLength > FILE_CHUNK_SIZE_BYTES + SECRETSTREAM_OVERHEAD_BYTES) {
    throw new Error('Invalid encrypted file chunk length')
  }
  if (frame.final !== (frame.digest !== undefined) || (frame.digest && frame.digest.byteLength !== DIGEST_BYTES)) {
    throw new Error('Final file chunk digest is invalid')
  }
  const digestBytes = frame.final ? DIGEST_BYTES : 0
  const output = new Uint8Array(FIXED_HEADER_BYTES + digestBytes + frame.ciphertext.byteLength)
  output[0] = PROTOCOL_VERSION
  output[1] = FILE_CHUNK_FRAME_TYPE
  output.set(attachmentId, 2)
  new DataView(output.buffer).setUint32(2 + MEMBER_ID_BYTES, frame.chunkIndex, false)
  output[FIXED_HEADER_BYTES - 1] = frame.final ? FINAL_FLAG : 0
  if (frame.digest) output.set(frame.digest, FIXED_HEADER_BYTES)
  output.set(frame.ciphertext, FIXED_HEADER_BYTES + digestBytes)
  return output.buffer
}

export function decodeFileChunk(buffer: ArrayBuffer): BinaryFileChunk {
  const bytes = new Uint8Array(buffer)
  if (bytes.byteLength < FIXED_HEADER_BYTES + SECRETSTREAM_OVERHEAD_BYTES) throw new Error('File chunk frame is too short')
  if (bytes[0] !== PROTOCOL_VERSION || bytes[1] !== FILE_CHUNK_FRAME_TYPE) throw new Error('Unsupported file chunk frame')
  const flags = bytes[FIXED_HEADER_BYTES - 1]!
  if ((flags & ~FINAL_FLAG) !== 0) throw new Error('File chunk frame flags are invalid')
  const final = (flags & FINAL_FLAG) !== 0
  const digestBytes = final ? DIGEST_BYTES : 0
  const ciphertextOffset = FIXED_HEADER_BYTES + digestBytes
  const ciphertextLength = bytes.byteLength - ciphertextOffset
  if (ciphertextLength < SECRETSTREAM_OVERHEAD_BYTES || ciphertextLength > FILE_CHUNK_SIZE_BYTES + SECRETSTREAM_OVERHEAD_BYTES) {
    throw new Error('Encrypted file chunk length is invalid')
  }
  return {
    attachmentId: base64UrlEncode(bytes.subarray(2, 2 + MEMBER_ID_BYTES)) as AttachmentId,
    chunkIndex: new DataView(buffer).getUint32(2 + MEMBER_ID_BYTES, false),
    final,
    ciphertext: bytes.slice(ciphertextOffset),
    ...(final ? { digest: bytes.slice(FIXED_HEADER_BYTES, ciphertextOffset) } : {}),
  }
}

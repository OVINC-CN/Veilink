import sodium from 'libsodium-wrappers-sumo'
import { base64UrlToBytes, bytesToBase64Url } from '../lib/encoding'

const encoder = new TextEncoder()

export interface EncryptedFileStart {
  fileId: string
  header: string
}

export interface EncryptedFileChunk {
  fileId: string
  index: number
  ciphertext: string
  final: boolean
  digest?: string
}

export interface ExpectedFileMetadata {
  digest: string
  size: number
  chunkSize: number
  chunkCount: number
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('File transfer cancelled', 'AbortError')
}

export async function hashFile(file: File, signal?: AbortSignal): Promise<string> {
  await sodium.ready
  throwIfAborted(signal)
  const hash = sodium.crypto_generichash_init(null, 32)
  for (let offset = 0; offset < file.size; offset += 64 * 1024) {
    const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + 64 * 1024)).arrayBuffer())
    try {
      throwIfAborted(signal)
      sodium.crypto_generichash_update(hash, bytes)
    } finally {
      sodium.memzero(bytes)
    }
  }
  throwIfAborted(signal)
  return bytesToBase64Url(sodium.crypto_generichash_final(hash, 32))
}

function deriveFileKey(rootFileKey: Uint8Array, fileId: string): Uint8Array {
  return sodium.crypto_generichash(32, encoder.encode(`veilink/v1/file/${fileId}`), rootFileKey)
}

export async function encryptFile(
  file: File,
  fileId: string,
  rootFileKey: Uint8Array,
  onStart: (start: EncryptedFileStart) => Promise<void> | void,
  onChunk: (chunk: EncryptedFileChunk) => Promise<void> | void,
  signal?: AbortSignal,
): Promise<void> {
  await sodium.ready
  throwIfAborted(signal)
  const key = deriveFileKey(rootFileKey, fileId)
  const stream = sodium.crypto_secretstream_xchacha20poly1305_init_push(key)
  const hash = sodium.crypto_generichash_init(null, 32)
  throwIfAborted(signal)
  await onStart({ fileId, header: bytesToBase64Url(stream.header) })
  let offset = 0
  let index = 0
  try {
    while (offset < file.size || (file.size === 0 && index === 0)) {
      throwIfAborted(signal)
      const nextOffset = Math.min(file.size, offset + 64 * 1024)
      const bytes = new Uint8Array(await file.slice(offset, nextOffset).arrayBuffer())
      try {
        throwIfAborted(signal)
        const final = nextOffset >= file.size
        sodium.crypto_generichash_update(hash, bytes)
        const encrypted = sodium.crypto_secretstream_xchacha20poly1305_push(
          stream.state,
          bytes,
          encoder.encode(`${fileId}|${index}`),
          final
            ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
            : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
        )
        await onChunk({
          fileId,
          index,
          ciphertext: bytesToBase64Url(encrypted),
          final,
          ...(final ? { digest: bytesToBase64Url(sodium.crypto_generichash_final(hash, 32)) } : {}),
        })
        throwIfAborted(signal)
      } finally {
        sodium.memzero(bytes)
      }
      offset = nextOffset
      index += 1
    }
  } finally {
    sodium.memzero(key)
  }
}

export class FileDecryptor {
  private readonly fileId: string
  private readonly key: Uint8Array
  private readonly state: ReturnType<typeof sodium.crypto_secretstream_xchacha20poly1305_init_pull>
  private readonly hash: ReturnType<typeof sodium.crypto_generichash_init>
  private readonly expected: ExpectedFileMetadata
  private readonly chunks: Uint8Array[] = []
  private nextIndex = 0
  private totalBytes = 0

  private constructor(fileId: string, rootFileKey: Uint8Array, header: string, expected: ExpectedFileMetadata) {
    this.fileId = fileId
    this.key = deriveFileKey(rootFileKey, fileId)
    this.state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(base64UrlToBytes(header), this.key)
    this.hash = sodium.crypto_generichash_init(null, 32)
    this.expected = expected
  }

  static async create(
    fileId: string,
    rootFileKey: Uint8Array,
    header: string,
    expected: ExpectedFileMetadata,
  ): Promise<FileDecryptor> {
    await sodium.ready
    return new FileDecryptor(fileId, rootFileKey, header, expected)
  }

  push(frame: EncryptedFileChunk): Blob | null {
    if (
      frame.fileId !== this.fileId ||
      frame.index !== this.nextIndex ||
      frame.index >= this.expected.chunkCount
    ) throw new Error('Unexpected encrypted file chunk')
    const expectedFinal = frame.index === this.expected.chunkCount - 1
    if (frame.final !== expectedFinal) throw new Error('Encrypted file final chunk is inconsistent with the offer')
    const result = sodium.crypto_secretstream_xchacha20poly1305_pull(
      this.state,
      base64UrlToBytes(frame.ciphertext),
      encoder.encode(`${this.fileId}|${frame.index}`),
    )
    if (!result) throw new Error('Encrypted file chunk failed authentication')
    const expectedTag = frame.final
      ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
      : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
    if (result.tag !== expectedTag) {
      sodium.memzero(result.message)
      throw new Error('Encrypted file stream tag is invalid')
    }
    const expectedChunkBytes = expectedFinal
      ? this.expected.size - (this.expected.chunkCount - 1) * this.expected.chunkSize
      : this.expected.chunkSize
    if (result.message.length !== expectedChunkBytes) {
      sodium.memzero(result.message)
      throw new Error('Encrypted file chunk length is inconsistent with the offer')
    }
    this.totalBytes += result.message.length
    if (this.totalBytes > this.expected.size) throw new Error('Encrypted file exceeds the offered size')
    sodium.crypto_generichash_update(this.hash, result.message)
    this.chunks.push(result.message)
    this.nextIndex += 1
    if (!frame.final) return null
    const digest = sodium.crypto_generichash_final(this.hash, 32)
    const expectedDigestBytes = base64UrlToBytes(this.expected.digest)
    const verified = sodium.memcmp(digest, expectedDigestBytes)
    sodium.memzero(digest)
    sodium.memzero(expectedDigestBytes)
    if (!verified) throw new Error('Encrypted file digest mismatch')
    const blobParts: ArrayBuffer[] = []
    for (const chunk of this.chunks) {
      const copy = new Uint8Array(chunk.byteLength)
      copy.set(chunk)
      blobParts.push(copy.buffer)
      sodium.memzero(chunk)
    }
    this.chunks.length = 0
    sodium.memzero(this.key)
    return new Blob(blobParts)
  }

  destroy(): void {
    sodium.memzero(this.key)
    for (const chunk of this.chunks) sodium.memzero(chunk)
    this.chunks.length = 0
  }
}

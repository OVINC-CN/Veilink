/// <reference lib="webworker" />

import sodium from 'libsodium-wrappers-sumo'
import {
  decodeFileChunk,
  DIGEST_BYTES,
  FILE_CHUNK_SIZE_BYTES,
  MAX_FILE_SIZE_BYTES,
  MEMBER_ID_BYTES,
  SECRETSTREAM_HEADER_BYTES,
} from '../protocol'
import { base64UrlToBytes, bytesToBase64Url } from '../lib/encoding'

const workerScope = self as unknown as DedicatedWorkerGlobalScope
const encoder = new TextEncoder()
const FILE_ENCRYPTION_CREDIT_WINDOW = 8

interface ExpectedFileMetadata {
  size: number
  chunkSize: number
  chunkCount: number
}

interface EncryptState {
  mode: 'encrypt'
  file: File
  fileId: string
  key: Uint8Array
  streamState: Parameters<typeof sodium.crypto_secretstream_xchacha20poly1305_push>[0]
  hash: ReturnType<typeof sodium.crypto_generichash_init>
  offset: number
  index: number
  credits: number
  pumping: boolean
  finished: boolean
}

interface DecryptState {
  mode: 'decrypt'
  fileId: string
  key: Uint8Array
  stream: ReturnType<typeof sodium.crypto_secretstream_xchacha20poly1305_init_pull>
  hash: ReturnType<typeof sodium.crypto_generichash_init>
  expected: ExpectedFileMetadata
  chunks: Uint8Array[]
  nextIndex: number
  totalBytes: number
}

let state: EncryptState | DecryptState | undefined

function deriveFileKey(rootFileKey: Uint8Array, fileId: string): Uint8Array {
  return sodium.crypto_generichash(32, encoder.encode(`veilink/v8/file/${fileId}`), rootFileKey)
}

function chunkAdditionalData(fileId: string, index: number, digest?: Uint8Array): Uint8Array {
  const prefix = encoder.encode(`veilink/v8/file-chunk|${fileId}|${index}|`)
  if (!digest) return prefix
  const output = new Uint8Array(prefix.byteLength + digest.byteLength)
  output.set(prefix)
  output.set(digest, prefix.byteLength)
  return output
}

function isCanonicalFileId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const bytes = base64UrlToBytes(value)
    return bytes.byteLength === MEMBER_ID_BYTES && bytesToBase64Url(bytes) === value
  } catch {
    return false
  }
}

function destroyState(): void {
  if (!state) return
  sodium.memzero(state.key)
  if (state.mode === 'decrypt') {
    for (const chunk of state.chunks) sodium.memzero(chunk)
    state.chunks.length = 0
  }
  state = undefined
}

function fail(error: unknown): void {
  destroyState()
  workerScope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'File crypto worker failed' })
}

function validateExpectedMetadata(value: unknown): ExpectedFileMetadata {
  if (!value || typeof value !== 'object') throw new Error('Invalid expected file metadata')
  const metadata = value as Partial<ExpectedFileMetadata>
  if (
    !Number.isSafeInteger(metadata.size) ||
    metadata.size! < 1 ||
    metadata.size! > MAX_FILE_SIZE_BYTES ||
    metadata.chunkSize !== FILE_CHUNK_SIZE_BYTES ||
    !Number.isSafeInteger(metadata.chunkCount) ||
    metadata.chunkCount !== Math.ceil(metadata.size! / FILE_CHUNK_SIZE_BYTES)
  ) {
    throw new Error('Invalid expected file metadata')
  }
  return {
    size: metadata.size!,
    chunkSize: metadata.chunkSize,
    chunkCount: metadata.chunkCount!,
  }
}

async function pumpEncryption(current: EncryptState): Promise<void> {
  if (current.pumping) return
  current.pumping = true
  try {
    while (state === current && current.credits > 0) {
      current.credits -= 1
      const nextOffset = Math.min(current.file.size, current.offset + FILE_CHUNK_SIZE_BYTES)
      const bytes = new Uint8Array(await current.file.slice(current.offset, nextOffset).arrayBuffer())
      if (state !== current) {
        sodium.memzero(bytes)
        return
      }
      const final = nextOffset >= current.file.size
      sodium.crypto_generichash_update(current.hash, bytes)
      const digest = final ? sodium.crypto_generichash_final(current.hash, 32) : undefined
      const encrypted = sodium.crypto_secretstream_xchacha20poly1305_push(
        current.streamState,
        bytes,
        chunkAdditionalData(current.fileId, current.index, digest),
        final ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
      )
      sodium.memzero(bytes)
      const response = {
        type: 'chunk',
        index: current.index,
        final,
        ciphertext: encrypted.buffer,
        ...(digest ? { digest: digest.buffer } : {}),
      }
      const transfers: Transferable[] = [encrypted.buffer, ...(digest ? [digest.buffer] : [])]
      current.offset = nextOffset
      current.index += 1
      workerScope.postMessage(response, transfers)
      if (final) {
        current.credits = 0
        current.finished = true
        return
      }
    }
  } finally {
    current.pumping = false
  }
}

workerScope.addEventListener('message', (event: MessageEvent<Record<string, unknown>>) => {
  void (async () => {
    await sodium.ready
    const message = event.data
    if (message.type === 'destroy') {
      destroyState()
      return
    }
    if (message.type === 'encrypt-init') {
      destroyState()
      const file = message.file
      const fileId = message.fileId
      const rootBuffer = message.rootFileKey
      if (
        !(file instanceof File) ||
        file.size < 1 ||
        file.size > MAX_FILE_SIZE_BYTES ||
        !isCanonicalFileId(fileId) ||
        !(rootBuffer instanceof ArrayBuffer) ||
        rootBuffer.byteLength !== DIGEST_BYTES
      ) throw new Error('Invalid file encryption request')
      const rootKey = new Uint8Array(rootBuffer)
      const key = deriveFileKey(rootKey, fileId)
      sodium.memzero(rootKey)
      const stream = sodium.crypto_secretstream_xchacha20poly1305_init_push(key)
      state = {
        mode: 'encrypt',
        file,
        fileId,
        key,
        streamState: stream.state,
        hash: sodium.crypto_generichash_init(null, 32),
        offset: 0,
        index: 0,
        credits: 0,
        pumping: false,
        finished: false,
      }
      workerScope.postMessage({ type: 'ready', header: bytesToBase64Url(stream.header) })
      return
    }
    if (message.type === 'encrypt-credit') {
      if (!state || state.mode !== 'encrypt') throw new Error('File encryptor is not initialized')
      const current = state
      if (current.finished) return
      const count = message.count
      if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > FILE_ENCRYPTION_CREDIT_WINDOW) {
        throw new Error('Invalid file encryption credit')
      }
      current.credits = Math.min(FILE_ENCRYPTION_CREDIT_WINDOW, current.credits + (count as number))
      await pumpEncryption(current)
      return
    }
    if (message.type === 'decrypt-init') {
      destroyState()
      const fileId = message.fileId
      const rootBuffer = message.rootFileKey
      const header = message.header
      if (
        !isCanonicalFileId(fileId) ||
        !(rootBuffer instanceof ArrayBuffer) ||
        rootBuffer.byteLength !== DIGEST_BYTES ||
        typeof header !== 'string'
      ) throw new Error('Invalid file decryption request')
      const headerBytes = base64UrlToBytes(header)
      if (
        headerBytes.byteLength !== SECRETSTREAM_HEADER_BYTES ||
        bytesToBase64Url(headerBytes) !== header
      ) throw new Error('Invalid file decryption request')
      const expected = validateExpectedMetadata(message.expected)
      const rootKey = new Uint8Array(rootBuffer)
      const key = deriveFileKey(rootKey, fileId)
      sodium.memzero(rootKey)
      state = {
        mode: 'decrypt',
        fileId,
        key,
        stream: sodium.crypto_secretstream_xchacha20poly1305_init_pull(headerBytes, key),
        hash: sodium.crypto_generichash_init(null, 32),
        expected,
        chunks: [],
        nextIndex: 0,
        totalBytes: 0,
      }
      workerScope.postMessage({ type: 'ready' })
      return
    }
    if (message.type === 'decrypt-frame') {
      if (!state || state.mode !== 'decrypt') throw new Error('File decryptor is not initialized')
      const current = state
      const frameBuffer = message.frame
      if (!(frameBuffer instanceof ArrayBuffer)) throw new Error('Invalid encrypted file chunk')
      const frame = decodeFileChunk(frameBuffer)
      const fileId = frame.attachmentId
      const index = frame.chunkIndex
      const final = frame.final
      if (fileId !== current.fileId) throw new Error('Invalid encrypted file chunk')
      const expectedFinal = index === current.expected.chunkCount - 1
      const digest = frame.digest
      if (index !== current.nextIndex || final !== expectedFinal || final !== (digest !== undefined) || (digest && digest.byteLength !== 32)) throw new Error('Unexpected encrypted file chunk')
      const result = sodium.crypto_secretstream_xchacha20poly1305_pull(
        current.stream,
        frame.ciphertext,
        chunkAdditionalData(current.fileId, index, digest),
      )
      if (!result) throw new Error('Encrypted file chunk failed authentication')
      const expectedTag = final ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
      const expectedBytes = expectedFinal
        ? current.expected.size - (current.expected.chunkCount - 1) * current.expected.chunkSize
        : current.expected.chunkSize
      if (result.tag !== expectedTag || result.message.byteLength !== expectedBytes) {
        sodium.memzero(result.message)
        throw new Error('Encrypted file chunk metadata is inconsistent')
      }
      current.totalBytes += result.message.byteLength
      if (current.totalBytes > current.expected.size) {
        sodium.memzero(result.message)
        throw new Error('Encrypted file exceeds the offered size')
      }
      sodium.crypto_generichash_update(current.hash, result.message)
      current.chunks.push(result.message)
      current.nextIndex += 1
      if (!final) {
        workerScope.postMessage({ type: 'decrypted' })
        return
      }
      const actualDigest = sodium.crypto_generichash_final(current.hash, 32)
      const verified = sodium.memcmp(actualDigest, digest!)
      sodium.memzero(actualDigest)
      if (!verified || current.totalBytes !== current.expected.size) throw new Error('Encrypted file digest mismatch')
      const blob = new Blob(current.chunks as Uint8Array<ArrayBuffer>[])
      destroyState()
      workerScope.postMessage({ type: 'decrypted', blob })
      return
    }
    throw new Error('Unknown file crypto worker request')
  })().catch(fail)
})

export {}

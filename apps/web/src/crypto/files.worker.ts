/// <reference lib="webworker" />

import sodium from 'libsodium-wrappers-sumo'
import { FILE_CHUNK_SIZE_BYTES } from '../protocol'
import { base64UrlToBytes, bytesToBase64Url } from '../lib/encoding'

const workerScope = self as unknown as DedicatedWorkerGlobalScope
const encoder = new TextEncoder()

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
      if (!(file instanceof File) || typeof fileId !== 'string' || !(rootBuffer instanceof ArrayBuffer)) throw new Error('Invalid file encryption request')
      const rootKey = new Uint8Array(rootBuffer)
      const key = deriveFileKey(rootKey, fileId)
      sodium.memzero(rootKey)
      const stream = sodium.crypto_secretstream_xchacha20poly1305_init_push(key)
      state = { mode: 'encrypt', file, fileId, key, streamState: stream.state, hash: sodium.crypto_generichash_init(null, 32), offset: 0, index: 0 }
      workerScope.postMessage({ type: 'ready', header: bytesToBase64Url(stream.header) })
      return
    }
    if (message.type === 'encrypt-next') {
      if (!state || state.mode !== 'encrypt') throw new Error('File encryptor is not initialized')
      const current = state
      const nextOffset = Math.min(current.file.size, current.offset + FILE_CHUNK_SIZE_BYTES)
      const bytes = new Uint8Array(await current.file.slice(current.offset, nextOffset).arrayBuffer())
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
      if (final) destroyState()
      return
    }
    if (message.type === 'decrypt-init') {
      destroyState()
      const fileId = message.fileId
      const rootBuffer = message.rootFileKey
      const header = message.header
      const expected = message.expected as ExpectedFileMetadata | undefined
      if (typeof fileId !== 'string' || !(rootBuffer instanceof ArrayBuffer) || typeof header !== 'string' || !expected) throw new Error('Invalid file decryption request')
      const rootKey = new Uint8Array(rootBuffer)
      const key = deriveFileKey(rootKey, fileId)
      sodium.memzero(rootKey)
      state = {
        mode: 'decrypt',
        fileId,
        key,
        stream: sodium.crypto_secretstream_xchacha20poly1305_init_pull(base64UrlToBytes(header), key),
        hash: sodium.crypto_generichash_init(null, 32),
        expected,
        chunks: [],
        nextIndex: 0,
        totalBytes: 0,
      }
      workerScope.postMessage({ type: 'ready' })
      return
    }
    if (message.type === 'decrypt-push') {
      if (!state || state.mode !== 'decrypt') throw new Error('File decryptor is not initialized')
      const current = state
      const fileId = message.fileId
      const index = message.index
      const final = message.final
      const ciphertextBuffer = message.ciphertext
      const digestBuffer = message.digest
      if (fileId !== current.fileId || !Number.isInteger(index) || typeof final !== 'boolean' || !(ciphertextBuffer instanceof ArrayBuffer)) throw new Error('Invalid encrypted file chunk')
      const expectedFinal = index === current.expected.chunkCount - 1
      const digest = digestBuffer instanceof ArrayBuffer ? new Uint8Array(digestBuffer) : undefined
      if (index !== current.nextIndex || final !== expectedFinal || final !== (digest !== undefined) || (digest && digest.byteLength !== 32)) throw new Error('Unexpected encrypted file chunk')
      const result = sodium.crypto_secretstream_xchacha20poly1305_pull(
        current.stream,
        new Uint8Array(ciphertextBuffer),
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
      if (current.totalBytes > current.expected.size) throw new Error('Encrypted file exceeds the offered size')
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
      const blobParts: ArrayBuffer[] = current.chunks.map((chunk) => chunk.slice().buffer)
      const blob = new Blob(blobParts)
      destroyState()
      workerScope.postMessage({ type: 'decrypted', blob })
      return
    }
    throw new Error('Unknown file crypto worker request')
  })().catch(fail)
})

export {}

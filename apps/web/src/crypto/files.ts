export interface EncryptedFileStart {
  fileId: string
  header: string
}

export interface EncryptedFileChunk {
  fileId: string
  index: number
  ciphertext: Uint8Array
  final: boolean
  digest?: Uint8Array
}

export interface ExpectedFileMetadata {
  size: number
  chunkSize: number
  chunkCount: number
}

type WorkerResponse =
  | { type: 'ready'; header?: string }
  | { type: 'chunk'; index: number; final: boolean; ciphertext: ArrayBuffer; digest?: ArrayBuffer }
  | { type: 'decrypted'; blob?: Blob }
  | { type: 'error'; message: string }

function abortError(): DOMException {
  return new DOMException('File transfer cancelled', 'AbortError')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function createFileWorker(): Worker {
  return new Worker(new URL('./files.worker.ts', import.meta.url), { type: 'module' })
}

function requestWorker(
  worker: Worker,
  message: unknown,
  transfer: Transferable[] = [],
  signal?: AbortSignal,
): Promise<WorkerResponse> {
  throwIfAborted(signal)
  return new Promise<WorkerResponse>((resolve, reject) => {
    const cleanup = (): void => {
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    const onMessage = (event: MessageEvent<WorkerResponse>): void => {
      cleanup()
      if (event.data.type === 'error') reject(new Error(event.data.message))
      else resolve(event.data)
    }
    const onError = (): void => {
      cleanup()
      reject(new Error('File crypto worker failed'))
    }
    const onAbort = (): void => {
      cleanup()
      worker.terminate()
      reject(abortError())
    }
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.postMessage(message, transfer)
  })
}

export async function encryptFile(
  file: File,
  fileId: string,
  rootFileKey: Uint8Array,
  onStart: (start: EncryptedFileStart) => Promise<void> | void,
  onChunk: (chunk: EncryptedFileChunk) => Promise<void> | void,
  signal?: AbortSignal,
): Promise<void> {
  const worker = createFileWorker()
  const key = rootFileKey.slice()
  try {
    const ready = await requestWorker(worker, { type: 'encrypt-init', file, fileId, rootFileKey: key.buffer }, [key.buffer], signal)
    if (ready.type !== 'ready' || !ready.header) throw new Error('File crypto worker did not initialize')
    await onStart({ fileId, header: ready.header })
    let final = false
    while (!final) {
      const response = await requestWorker(worker, { type: 'encrypt-next' }, [], signal)
      if (response.type !== 'chunk') throw new Error('File crypto worker returned an invalid chunk')
      final = response.final
      await onChunk({
        fileId,
        index: response.index,
        final,
        ciphertext: new Uint8Array(response.ciphertext),
        ...(response.digest ? { digest: new Uint8Array(response.digest) } : {}),
      })
    }
  } finally {
    try { worker.postMessage({ type: 'destroy' }) } catch { /* The worker may already be terminated. */ }
    worker.terminate()
  }
}

export class FileDecryptor {
  private destroyed = false
  private readonly controller = new AbortController()

  private constructor(
    private readonly worker: Worker,
    private readonly fileId: string,
  ) {}

  static async create(
    fileId: string,
    rootFileKey: Uint8Array,
    header: string,
    expected: ExpectedFileMetadata,
  ): Promise<FileDecryptor> {
    const worker = createFileWorker()
    const key = rootFileKey.slice()
    try {
      const ready = await requestWorker(worker, {
        type: 'decrypt-init',
        fileId,
        rootFileKey: key.buffer,
        header,
        expected,
      }, [key.buffer])
      if (ready.type !== 'ready') throw new Error('File crypto worker did not initialize')
      return new FileDecryptor(worker, fileId)
    } catch (error) {
      worker.terminate()
      throw error
    }
  }

  async push(frame: EncryptedFileChunk): Promise<Blob | null> {
    if (this.destroyed || frame.fileId !== this.fileId) throw new Error('File decryptor is unavailable')
    const ciphertext = frame.ciphertext.slice()
    const digest = frame.digest?.slice()
    const response = await requestWorker(this.worker, {
      type: 'decrypt-push',
      fileId: frame.fileId,
      index: frame.index,
      final: frame.final,
      ciphertext: ciphertext.buffer,
      ...(digest ? { digest: digest.buffer } : {}),
    }, [ciphertext.buffer, ...(digest ? [digest.buffer] : [])], this.controller.signal)
    if (response.type !== 'decrypted') throw new Error('File crypto worker returned an invalid response')
    return response.blob ?? null
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.controller.abort()
    try { this.worker.postMessage({ type: 'destroy' }) } catch { /* The worker may already be terminated. */ }
    this.worker.terminate()
  }
}

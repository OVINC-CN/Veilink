import type { DerivedKeys } from './types'

interface WorkerSuccess {
  ok: true
  keys: {
    admissionKey: Uint8Array
    messageKey: Uint8Array
    fileKey: Uint8Array
    fingerprintKey: Uint8Array
    fingerprint: string
  }
}

interface WorkerFailure {
  ok: false
  error: string
}

export async function deriveRoomKeys(pin: string, roomId: string, linkSecret: string): Promise<DerivedKeys> {
  const worker = new Worker(new URL('./derive.worker.ts', import.meta.url), { type: 'module' })
  try {
    return await new Promise<DerivedKeys>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Key derivation timed out')), 60_000)
      worker.addEventListener('message', (event: MessageEvent<WorkerSuccess | WorkerFailure>) => {
        window.clearTimeout(timeout)
        if (!event.data.ok) {
          reject(new Error(event.data.error))
          return
        }
        resolve({
          admissionKey: event.data.keys.admissionKey,
          messageKey: event.data.keys.messageKey,
          fileKey: event.data.keys.fileKey,
          fingerprintKey: event.data.keys.fingerprintKey,
          fingerprint: event.data.keys.fingerprint,
        })
      }, { once: true })
      worker.addEventListener('error', () => {
        window.clearTimeout(timeout)
        reject(new Error('Key derivation worker failed'))
      }, { once: true })
      worker.postMessage({ pin, roomId, linkSecret })
    })
  } finally {
    worker.terminate()
  }
}

const previewable = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'video/mp4',
  'video/webm',
  'application/pdf',
])

const textDecoder = new TextDecoder()

function looksLikeActiveText(bytes: Uint8Array): boolean {
  const prefix = textDecoder
    .decode(bytes.subarray(0, Math.min(bytes.length, 1_024)))
    .replace(/^\uFEFF/u, '')
    .trimStart()
    .toLowerCase()
  return /^(?:<\?xml[^>]*>\s*)?(?:<!doctype\s+html|<html|<svg|<script)/u.test(prefix)
}

export interface ValidatedMedia {
  mime: string
  previewable: boolean
}

export async function validateMedia(bytes: Uint8Array, declaredMime: string): Promise<ValidatedMedia> {
  if (looksLikeActiveText(bytes)) return { mime: 'application/octet-stream', previewable: false }
  const { fileTypeFromBuffer } = await import('file-type')
  const detected = await fileTypeFromBuffer(bytes.subarray(0, Math.min(bytes.length, 8192)))
  const declared = declaredMime.toLowerCase()
  const mime = detected?.mime ?? declared
  if (mime === 'image/svg+xml' || mime === 'text/html' || mime.includes('javascript')) {
    return { mime, previewable: false }
  }
  if (detected && declared && declared !== 'application/octet-stream' && detected.mime !== declared) {
    throw new Error(`File type mismatch: declared ${declaredMime}, detected ${detected.mime}`)
  }
  return { mime, previewable: detected !== undefined && previewable.has(detected.mime) }
}

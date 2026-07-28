import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  brotliCompress as brotliCompressCallback,
  constants,
  gzip as gzipCallback,
} from 'node:zlib'

const brotliCompress = promisify(brotliCompressCallback)
const gzip = promisify(gzipCallback)
const outputRoot = fileURLToPath(new URL('../dist/', import.meta.url))

const compressibleExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.mjs',
  '.svg',
  '.txt',
  '.xml',
])

const minimumSourceBytes = 256
const minimumSavingsBytes = 64
const minimumSavingsRatio = 0.05

async function collectCompressibleFiles(directory) {
  const files = []
  const entries = await readdir(directory, { withFileTypes: true })

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectCompressibleFiles(path)))
      continue
    }
    if (
      entry.isFile() &&
      !entry.name.endsWith('.br') &&
      !entry.name.endsWith('.gz') &&
      compressibleExtensions.has(extname(entry.name).toLowerCase())
    ) {
      files.push(path)
    }
  }

  return files
}

function isWorthKeeping(sourceSize, compressedSize) {
  const savings = sourceSize - compressedSize
  return (
    savings >= minimumSavingsBytes &&
    savings / sourceSize >= minimumSavingsRatio
  )
}

async function writeSidecar(sourcePath, suffix, sourceSize, compressed) {
  const sidecarPath = `${sourcePath}${suffix}`
  if (!isWorthKeeping(sourceSize, compressed.byteLength)) {
    await rm(sidecarPath, { force: true })
    return false
  }

  await writeFile(sidecarPath, compressed)
  return true
}

const files = await collectCompressibleFiles(outputRoot)
let compressedFiles = 0
let sidecars = 0

for (const path of files) {
  const source = await readFile(path)
  if (source.byteLength < minimumSourceBytes) {
    await Promise.all([
      rm(`${path}.br`, { force: true }),
      rm(`${path}.gz`, { force: true }),
    ])
    continue
  }

  const [brotli, gzipped] = await Promise.all([
    brotliCompress(source, {
      params: {
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_QUALITY]: 11,
      },
    }),
    gzip(source, { level: constants.Z_BEST_COMPRESSION }),
  ])
  const results = await Promise.all([
    writeSidecar(path, '.br', source.byteLength, brotli),
    writeSidecar(path, '.gz', source.byteLength, gzipped),
  ])
  const written = results.filter(Boolean).length
  if (written > 0) {
    compressedFiles += 1
    sidecars += written
  }
}

console.log(
  `Precompressed ${compressedFiles} static files into ${sidecars} Brotli/Gzip sidecars.`,
)

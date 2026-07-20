import { fileURLToPath } from 'node:url'

import { buildApp } from './app.js'

export { buildApp } from './app.js'
export { loadConfig } from './config.js'
export { RoomStore } from './room-store.js'

async function main(): Promise<void> {
  const { app, config } = await buildApp()

  const shutdown = async () => {
    process.removeListener('SIGINT', shutdown)
    process.removeListener('SIGTERM', shutdown)
    await app.close()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  await app.listen({ host: config.host, port: config.port })
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && fileURLToPath(import.meta.url) === entrypoint) {
  main().catch(() => {
    process.stderr.write('Veilink server failed to start.\n')
    process.exitCode = 1
  })
}

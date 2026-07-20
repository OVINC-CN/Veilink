import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildApp, type AppContext } from '../src/app.js'
import { loadConfig } from '../src/config.js'

let context: AppContext | undefined
let temporaryStaticRoot: string | undefined

afterEach(async () => {
  await context?.app.close()
  if (temporaryStaticRoot !== undefined) {
    await rm(temporaryStaticRoot, { recursive: true, force: true })
  }
  context = undefined
  temporaryStaticRoot = undefined
})

describe('Fastify application', () => {
  it('serves privacy-safe health and public configuration responses', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      APP_ORIGIN: 'https://veilink.example',
      WEB_DIST_DIR: '/path/that/does/not/exist',
      TURN_REST_SECRET: 'a-production-grade-turn-secret-value',
      TURN_URLS: 'turn:turn.example:3478?transport=udp',
    })
    context = await buildApp({ config })

    const health = await context.app.inject({ method: 'GET', url: '/healthz' })
    expect(health.statusCode).toBe(200)
    expect(health.json()).toEqual({ status: 'ok' })
    expect(health.headers['cache-control']).toBe('no-store, max-age=0')
    expect(health.headers['content-security-policy']).toContain("default-src 'self'")
    expect(health.headers['permissions-policy']).toContain('camera=()')

    const publicConfig = await context.app.inject({
      method: 'GET',
      url: '/api/config',
      headers: { origin: 'https://veilink.example' },
    })
    expect(publicConfig.statusCode).toBe(200)
    expect(publicConfig.json()).not.toHaveProperty('turnRestSecret')
    expect(publicConfig.json()).not.toHaveProperty('ice')
    expect(publicConfig.json().protocolVersion).toBe(2)
  })

  it('rejects a cross-origin browser request to guarded endpoints', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      APP_ORIGIN: 'https://veilink.example',
      WEB_DIST_DIR: '/path/that/does/not/exist',
      TURN_REST_SECRET: 'a-production-grade-turn-secret-value',
      TURN_URLS: 'turn:turn.example:3478?transport=udp',
    })
    context = await buildApp({ config })
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/config',
      headers: { origin: 'https://attacker.example' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'forbidden_origin' })
  })

  it('serves the static SPA fallback without allowing response caching', async () => {
    temporaryStaticRoot = await mkdtemp(join(tmpdir(), 'veilink-static-'))
    await writeFile(join(temporaryStaticRoot, 'index.html'), '<!doctype html><title>Veilink</title>')
    const config = loadConfig({
      NODE_ENV: 'test',
      APP_ORIGIN: 'https://veilink.example',
      WEB_DIST_DIR: temporaryStaticRoot,
      TURN_REST_SECRET: 'a-production-grade-turn-secret-value',
      TURN_URLS: 'turn:turn.example:3478?transport=udp',
    })
    context = await buildApp({ config })

    const response = await context.app.inject({
      method: 'GET',
      url: '/room/AAAAAAAAAAAAAAAAAAAAAA',
      headers: { accept: 'text/html' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('<title>Veilink</title>')
    expect(response.headers['cache-control']).toBe('no-store, max-age=0')
  })

  it('requires an exact application origin in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow('APP_ORIGIN is required')
    expect(() =>
      loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://veilink.example/' }),
    ).toThrow('exact HTTP(S) origin')
  })
})

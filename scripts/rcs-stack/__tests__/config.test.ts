import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  needsProductionWebBuild,
  resolveProxyEnv,
  resolveStackConfig,
} from '../config.js'

describe('resolveStackConfig', () => {
  test('generates and shares a secret without exposing it as metadata', () => {
    const config = resolveStackConfig('local', {}, () => 'generated-secret')

    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(3000)
    expect(config.healthUrl).toBe('http://127.0.0.1:3000/health')
    expect(config.readyUrl).toBe('http://127.0.0.1:3000/ready')
    expect(config.rcsEnv.RCS_API_KEYS).toBe('generated-secret')
    expect(config.workerEnv.CLAUDE_BRIDGE_OAUTH_TOKEN).toBe('generated-secret')
    expect(config.apiKeyCount).toBe(1)
    expect(JSON.stringify(config.publicSummary)).not.toContain(
      'generated-secret',
    )
  })

  test('preserves multiple keys and selects the first non-empty worker key', () => {
    const config = resolveStackConfig('local', {
      RCS_API_KEYS: ' first , second ',
      CLAUDE_BRIDGE_OAUTH_TOKEN: 'stale',
    })

    expect(config.rcsEnv.RCS_API_KEYS).toBe('first,second')
    expect(config.workerEnv.CLAUDE_BRIDGE_OAUTH_TOKEN).toBe('first')
    expect(config.apiKeyCount).toBe(2)
  })

  test('rejects an explicitly empty key list', () => {
    expect(() => resolveStackConfig('local', { RCS_API_KEYS: ' , ' })).toThrow(
      'RCS_API_KEYS must contain at least one non-empty key',
    )
  })

  test('uses loopback for the local worker when RCS listens on all interfaces', () => {
    const config = resolveStackConfig(
      'dev',
      { RCS_HOST: '0.0.0.0', RCS_PORT: '4100' },
      () => 'generated-secret',
    )

    expect(config.host).toBe('0.0.0.0')
    expect(config.healthUrl).toBe('http://127.0.0.1:4100/health')
    expect(config.workerEnv.CLAUDE_BRIDGE_BASE_URL).toBe(
      'http://127.0.0.1:4100',
    )
    expect(config.webUrl).toBe('http://127.0.0.1:5173/code/')
  })

  test('respects an explicit bridge base URL', () => {
    const config = resolveStackConfig(
      'local',
      { CLAUDE_BRIDGE_BASE_URL: 'https://rcs.example.test/' },
      () => 'generated-secret',
    )

    expect(config.workerEnv.CLAUDE_BRIDGE_BASE_URL).toBe(
      'https://rcs.example.test/',
    )
  })
})

test('production Web build is only needed for local mode with no dist', () => {
  expect(needsProductionWebBuild('local', false)).toBe(true)
  expect(needsProductionWebBuild('local', true)).toBe(false)
  expect(needsProductionWebBuild('dev', false)).toBe(false)
})

test('package scripts expose layered RCS entrypoints', () => {
  const pkg = JSON.parse(
    readFileSync(resolve(import.meta.dir, '../../../package.json'), 'utf8'),
  ) as { scripts: Record<string, string> }

  expect(pkg.scripts['rcs:local']).toBe(
    'bun run scripts/rcs-stack/main.ts local',
  )
  expect(pkg.scripts['rcs:dev']).toBe('bun run scripts/rcs-stack/main.ts dev')
  expect(pkg.scripts['rcs:server']).toBe('bun run scripts/rcs.ts')
  expect(pkg.scripts['rcs:worker']).toBe('bun run scripts/rcs-worker.ts')
  expect(pkg.scripts.rcs).toBe('bun run rcs:server')
})

describe('resolveProxyEnv', () => {
  test('returns nothing when the host has no proxy configured', () => {
    expect(resolveProxyEnv({})).toEqual({})
  })

  test('propagates the ambient proxy in both cases and shields loopback', () => {
    // The stack inherits process.env, but only the launching shell's view of
    // it. Normalising here is what makes the worker's outbound reachability
    // independent of how `bun run rcs` happened to be started.
    const env = resolveProxyEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890' })

    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.https_proxy).toBe('http://127.0.0.1:7890')
    expect(env.NO_PROXY).toContain('127.0.0.1')
    expect(env.NO_PROXY).toContain('localhost')
    expect(env.no_proxy).toBe(env.NO_PROXY)
  })

  test('RCS_* overrides win over the ambient proxy', () => {
    const env = resolveProxyEnv({
      HTTPS_PROXY: 'http://ambient:1',
      RCS_HTTPS_PROXY: 'http://override:2',
    })

    expect(env.HTTPS_PROXY).toBe('http://override:2')
  })

  test('keeps the operator NO_PROXY entries and appends loopback once', () => {
    const env = resolveProxyEnv({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'corp.internal,127.0.0.1',
    })

    expect(env.NO_PROXY).toBe('corp.internal,127.0.0.1,localhost,::1')
  })

  test('a proxy set only in lowercase still reaches the children', () => {
    expect(
      resolveProxyEnv({ https_proxy: 'http://127.0.0.1:7890' }).HTTPS_PROXY,
    ).toBe('http://127.0.0.1:7890')
  })
})

describe('resolveStackConfig proxy propagation', () => {
  test('injects the proxy into both the RCS and worker child env', () => {
    const config = resolveStackConfig(
      'local',
      { HTTPS_PROXY: 'http://127.0.0.1:7890' },
      () => 'secret',
    )

    expect(config.rcsEnv.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(config.workerEnv.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(config.workerEnv.NO_PROXY).toContain('127.0.0.1')
  })

  test('leaves the child env untouched when no proxy is configured', () => {
    const config = resolveStackConfig('local', {}, () => 'secret')

    expect(config.workerEnv.HTTPS_PROXY).toBeUndefined()
    expect(config.workerEnv.NO_PROXY).toBeUndefined()
  })
})

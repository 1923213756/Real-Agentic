import { describe, expect, test } from 'bun:test'
import { createCleanupRegistry } from '../cleanupRegistry.js'

describe('cleanupRegistry', () => {
  test('runs phases in order while allowing entries within a phase to overlap', async () => {
    const { registerCleanup, runCleanupFunctions } = createCleanupRegistry()
    const events: string[] = []

    registerCleanup(
      async () => {
        events.push('terminate-a:start')
        await Bun.sleep(15)
        events.push('terminate-a:end')
      },
      { name: 'terminate-a', phase: 'terminate' },
    )
    registerCleanup(
      async () => {
        events.push('terminate-b:start')
        await Bun.sleep(5)
        events.push('terminate-b:end')
      },
      { name: 'terminate-b', phase: 'terminate' },
    )
    registerCleanup(
      () => {
        events.push('persist')
      },
      { name: 'persist', phase: 'persist' },
    )

    const report = await runCleanupFunctions({ timeoutMs: 200 })

    expect(report).toEqual({ completed: 3, failures: [], timedOut: false })
    expect(events.slice(0, 2).sort()).toEqual([
      'terminate-a:start',
      'terminate-b:start',
    ])
    expect(events.indexOf('persist')).toBeGreaterThan(
      events.indexOf('terminate-a:end'),
    )
    expect(events.indexOf('persist')).toBeGreaterThan(
      events.indexOf('terminate-b:end'),
    )
  })

  test('isolates failures and enforces per-entry timeouts', async () => {
    const { registerCleanup, runCleanupFunctions } = createCleanupRegistry()
    registerCleanup(
      () => {
        throw new Error('cleanup failed')
      },
      { name: 'broken', phase: 'dispose' },
    )
    registerCleanup(() => new Promise<void>(() => {}), {
      name: 'stuck',
      phase: 'dispose',
      timeoutMs: 15,
    })
    registerCleanup(() => {}, { name: 'healthy', phase: 'dispose' })

    const report = await runCleanupFunctions({ timeoutMs: 100 })

    expect(report.completed).toBe(1)
    expect(report.timedOut).toBe(true)
    expect(
      report.failures.map(({ name, reason }) => ({ name, reason })).sort(),
    ).toEqual([
      { name: 'broken', reason: 'error' },
      { name: 'stuck', reason: 'timeout' },
    ])
  })

  test('runs a registered cleanup at most once', async () => {
    const { registerCleanup, runCleanupFunctions } = createCleanupRegistry()
    let calls = 0
    registerCleanup(() => {
      calls += 1
    })

    expect((await runCleanupFunctions()).completed).toBe(1)
    expect((await runCleanupFunctions()).completed).toBe(0)
    expect(calls).toBe(1)
  })
})

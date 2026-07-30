import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type {
  ChildProcess,
  SpawnOptions,
  spawn as nodeSpawn,
} from 'node:child_process'
import { createSessionSpawner } from '../sessionRunner.js'
import type { SessionHandle } from '../types.js'

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  Object.assign(child, {
    pid: 123,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  })
  return child
}

function spawnWithStdout(): { handle: SessionHandle; stdout: PassThrough } {
  let stdout!: PassThrough
  const spawnProcess = ((
    _command: string,
    _args: readonly string[],
    _options: SpawnOptions,
  ) => {
    const child = fakeChild()
    stdout = child.stdout as unknown as PassThrough
    return child
  }) as typeof nodeSpawn
  const spawner = createSessionSpawner({
    execPath: '/test/claude',
    scriptArgs: [],
    env: {},
    spawnProcess,
    verbose: false,
    sandbox: false,
    onDebug: () => {},
  })
  const handle = spawner.spawn(
    {
      sessionId: 'session-turn-state',
      sdkUrl: 'https://rcs.test/v1/sessions/session-turn-state',
      accessToken: 'session-token',
    },
    '/workspace',
  )
  return { handle, stdout }
}

/** Let the readline 'line' handlers drain before asserting. */
async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 10))
}

describe('session runner turn state', () => {
  test('a fresh child is idle, so a turn it never receives cannot pin a slot', async () => {
    // Regression: initialising busy=true meant children spawned by rebind or
    // re-dispatch — which never get a turn, so never emit the result that
    // clears the flag — stayed busy forever and held a capacity slot for good.
    const { handle } = spawnWithStdout()
    try {
      expect(handle.busy).toBe(false)
    } finally {
      handle.kill()
    }
  })

  test('tracks turn boundaries from the child stream', async () => {
    const { handle, stdout } = spawnWithStdout()
    try {
      // The replayed user message is the turn-start signal.
      stdout.write(
        `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`,
      )
      await flush()
      expect(handle.busy).toBe(true)

      stdout.write(
        `${JSON.stringify({ type: 'result', subtype: 'success' })}\n`,
      )
      await flush()
      expect(handle.busy).toBe(false)
    } finally {
      handle.kill()
    }
  })

  test('a failed turn also ends the turn, keeping the child evictable', async () => {
    const { handle, stdout } = spawnWithStdout()
    try {
      stdout.write(
        `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`,
      )
      await flush()
      expect(handle.busy).toBe(true)

      stdout.write(
        `${JSON.stringify({ type: 'result', subtype: 'error_during_execution' })}\n`,
      )
      await flush()
      expect(handle.busy).toBe(false)
    } finally {
      handle.kill()
    }
  })

  test('markTurnStarted covers the dispatch-to-echo window', async () => {
    const { handle } = spawnWithStdout()
    try {
      expect(handle.busy).toBe(false)
      // The bridge marks a resident child busy when it hands over work, before
      // the child echoes the user message — otherwise a concurrent admission
      // could pick a session that is about to run as the idle LRU victim.
      handle.markTurnStarted()
      expect(handle.busy).toBe(true)
    } finally {
      handle.kill()
    }
  })

  test('advances lastActivityAt so LRU reaches stale children first', async () => {
    const { handle, stdout } = spawnWithStdout()
    try {
      const spawnedAt = handle.lastActivityAt
      expect(spawnedAt).toBeGreaterThan(0)
      await new Promise(resolve => setTimeout(resolve, 5))
      stdout.write(
        `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`,
      )
      await flush()
      expect(handle.lastActivityAt).toBeGreaterThan(spawnedAt)
    } finally {
      handle.kill()
    }
  })
})

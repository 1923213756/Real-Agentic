import { describe, expect, test } from 'bun:test'
import { resolveStackConfig } from '../config.js'
import {
  runStack,
  type ChildExit,
  type ManagedChild,
  type SpawnRequest,
  type StackDependencies,
} from '../supervisor.js'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => {
    resolve = next
  })
  return { promise, resolve }
}

class FakeChild implements ManagedChild {
  private readonly completion = deferred<ChildExit>()
  readonly exited = this.completion.promise
  readonly killCalls: NodeJS.Signals[] = []
  exit: ChildExit | null = null

  constructor(
    readonly name: SpawnRequest['name'],
    private readonly ignoreTerm = false,
    private readonly onKill?: (signal: NodeJS.Signals) => void,
  ) {}

  finish(code: number, signal: NodeJS.Signals | null = null): void {
    if (this.exit) return
    this.exit = { code, signal }
    this.completion.resolve(this.exit)
  }

  kill(signal: NodeJS.Signals): void {
    this.killCalls.push(signal)
    this.onKill?.(signal)
    if (signal === 'SIGTERM' && this.ignoreTerm) return
    this.finish(signal === 'SIGKILL' ? 137 : 0, signal)
  }
}

function createDependencies(options: {
  distExists: boolean
  healthResults: boolean[]
  workerExitCode?: number
  healthTimeoutMs?: number
  stubbornChildren?: SpawnRequest['name'][]
}): {
  dependencies: StackDependencies
  events: string[]
  killOrder: string[]
  children: Partial<Record<SpawnRequest['name'], FakeChild>>
  sendSignal: (value: NodeJS.Signals) => void
} {
  const events: string[] = []
  const killOrder: string[] = []
  const children: Partial<Record<SpawnRequest['name'], FakeChild>> = {}
  const signal = deferred<NodeJS.Signals>()
  let now = 0
  let healthIndex = 0
  const dependencies: StackDependencies = {
    rootDir: '/repo',
    bunExecutable: '/bun',
    distExists: async () => options.distExists,
    spawn(request) {
      events.push(`spawn:${request.name}`)
      const child = new FakeChild(
        request.name,
        options.stubbornChildren?.includes(request.name),
        childSignal => killOrder.push(`${request.name}:${childSignal}`),
      )
      children[request.name] = child
      if (request.name === 'web-build') child.finish(0)
      if (request.name === 'worker' && options.workerExitCode !== undefined) {
        queueMicrotask(() => child.finish(options.workerExitCode!))
      }
      return child
    },
    async isHealthy() {
      events.push(`health:${healthIndex + 1}`)
      return options.healthResults[healthIndex++] ?? false
    },
    async delay(milliseconds) {
      now += milliseconds
    },
    now: () => now,
    signal: signal.promise,
    log: () => {},
    healthTimeoutMs: options.healthTimeoutMs ?? 15_000,
    healthPollMs: 10,
    shutdownGraceMs: 10,
  }
  return {
    dependencies,
    events,
    killOrder,
    children,
    sendSignal: signal.resolve,
  }
}

describe('runStack', () => {
  test('builds missing Web assets, waits for health, and cleans up after a critical exit', async () => {
    const config = resolveStackConfig('local', {}, () => 'secret')
    const harness = createDependencies({
      distExists: false,
      healthResults: [false, true],
      workerExitCode: 7,
    })

    const result = await runStack(config, harness.dependencies)

    expect(harness.events).toEqual([
      'spawn:web-build',
      'spawn:rcs',
      'health:1',
      'health:2',
      'spawn:worker',
    ])
    expect(result).toEqual({ reason: 'child-exit', exitCode: 7 })
    expect(harness.children.rcs?.killCalls).toEqual(['SIGTERM'])
    expect(harness.children.worker?.killCalls).toEqual([])
  })

  test('does not start a worker when the RCS health check times out', async () => {
    const config = resolveStackConfig('local', {}, () => 'secret')
    const harness = createDependencies({
      distExists: true,
      healthResults: [false, false, false],
      healthTimeoutMs: 20,
    })

    const result = await runStack(config, harness.dependencies)

    expect(harness.events).toEqual([
      'spawn:rcs',
      'health:1',
      'health:2',
      'health:3',
    ])
    expect(harness.children.worker).toBeUndefined()
    expect(harness.children.rcs?.killCalls).toEqual(['SIGTERM'])
    expect(result).toEqual({ reason: 'startup-failure', exitCode: 1 })
  })

  test('dev mode starts Vite without running the production Web build', async () => {
    const config = resolveStackConfig('dev', {}, () => 'secret')
    const harness = createDependencies({
      distExists: false,
      healthResults: [true],
      workerExitCode: 0,
    })

    await runStack(config, harness.dependencies)

    expect(harness.events).toEqual([
      'spawn:rcs',
      'health:1',
      'spawn:web',
      'spawn:worker',
    ])
    expect(harness.children.web?.killCalls).toEqual(['SIGTERM'])
  })

  test('force-kills a stuck Worker before stopping RCS', async () => {
    const config = resolveStackConfig('local', {}, () => 'secret')
    const harness = createDependencies({
      distExists: true,
      healthResults: [true],
      stubbornChildren: ['worker'],
    })

    const running = runStack(config, harness.dependencies)
    while (!harness.children.worker) await Promise.resolve()
    harness.sendSignal('SIGINT')

    expect(await running).toEqual({ reason: 'signal', exitCode: 130 })
    expect(harness.children.worker.killCalls).toEqual(['SIGTERM', 'SIGKILL'])
    expect(harness.killOrder).toEqual([
      'worker:SIGTERM',
      'worker:SIGKILL',
      'rcs:SIGTERM',
    ])
  })
})

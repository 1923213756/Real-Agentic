/**
 * Global registry for cleanup functions that should run during graceful
 * shutdown. Kept separate from gracefulShutdown.ts to avoid circular imports.
 */

export type CleanupPhase = 'quiesce' | 'terminate' | 'persist' | 'dispose'

export type CleanupOptions = {
  name?: string
  phase?: CleanupPhase
  /** Per-cleanup cap. The remaining global budget is always the upper bound. */
  timeoutMs?: number
}

type CleanupEntry = {
  cleanup: () => void | Promise<void>
  name: string
  phase: CleanupPhase
  timeoutMs?: number
}

export type CleanupFailure = {
  name: string
  phase: CleanupPhase
  reason: 'error' | 'timeout'
  error?: unknown
}

export type CleanupReport = {
  completed: number
  failures: CleanupFailure[]
  timedOut: boolean
}

const PHASE_ORDER: CleanupPhase[] = [
  'quiesce',
  'terminate',
  'persist',
  'dispose',
]

class CleanupEntryTimeoutError extends Error {}

async function runEntry(
  entry: CleanupEntry,
  remainingGlobalMs: number,
): Promise<CleanupFailure | null> {
  const timeoutMs = Math.max(
    0,
    Math.min(entry.timeoutMs ?? remainingGlobalMs, remainingGlobalMs),
  )
  if (timeoutMs === 0) {
    return { name: entry.name, phase: entry.phase, reason: 'timeout' }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(entry.cleanup),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new CleanupEntryTimeoutError()),
          timeoutMs,
        )
      }),
    ])
    return null
  } catch (error) {
    return {
      name: entry.name,
      phase: entry.phase,
      reason: error instanceof CleanupEntryTimeoutError ? 'timeout' : 'error',
      error: error instanceof CleanupEntryTimeoutError ? undefined : error,
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Run a stable snapshot exactly once. Phases are ordered so new work is first
 * quiesced, child processes are then reaped, state is persisted, and finally
 * passive resources are disposed. Entries within a phase run concurrently.
 */
export type CleanupRegistry = {
  registerCleanup: typeof registerCleanup
  runCleanupFunctions: typeof runCleanupFunctions
  reset: () => void
}

/**
 * Create an isolated registry. Production uses the singleton below; tests and
 * embedders can use a private instance without consuming process-wide hooks.
 */
export function createCleanupRegistry(): CleanupRegistry {
  const cleanupFunctions = new Set<CleanupEntry>()

  const register: CleanupRegistry['registerCleanup'] = (
    cleanup,
    options = {},
  ) => {
    const entry: CleanupEntry = {
      cleanup,
      name: options.name ?? cleanup.name ?? 'anonymous-cleanup',
      phase: options.phase ?? 'dispose',
      timeoutMs: options.timeoutMs,
    }
    cleanupFunctions.add(entry)
    return () => cleanupFunctions.delete(entry)
  }

  const run: CleanupRegistry['runCleanupFunctions'] = async (options = {}) => {
    const timeoutMs = options.timeoutMs ?? 10_000
    const deadline = Date.now() + timeoutMs
    const entries = [...cleanupFunctions]
    for (const entry of entries) cleanupFunctions.delete(entry)

    const failures: CleanupFailure[] = []
    let completed = 0
    for (const phase of PHASE_ORDER) {
      const phaseEntries = entries.filter(entry => entry.phase === phase)
      if (phaseEntries.length === 0) continue
      const remainingGlobalMs = deadline - Date.now()
      if (remainingGlobalMs <= 0) {
        failures.push(
          ...phaseEntries.map(entry => ({
            name: entry.name,
            phase: entry.phase,
            reason: 'timeout' as const,
          })),
        )
        continue
      }
      const results = await Promise.all(
        phaseEntries.map(entry => runEntry(entry, remainingGlobalMs)),
      )
      for (const result of results) {
        if (result) failures.push(result)
        else completed += 1
      }
    }

    return {
      completed,
      failures,
      timedOut: failures.some(failure => failure.reason === 'timeout'),
    }
  }

  return {
    registerCleanup: register,
    runCleanupFunctions: run,
    reset: () => cleanupFunctions.clear(),
  }
}

const globalCleanupRegistry = createCleanupRegistry()

export function registerCleanup(
  cleanup: () => void | Promise<void>,
  options: CleanupOptions = {},
): () => void {
  return globalCleanupRegistry.registerCleanup(cleanup, options)
}

export function runCleanupFunctions(
  options: { timeoutMs?: number } = {},
): Promise<CleanupReport> {
  return globalCleanupRegistry.runCleanupFunctions(options)
}

export function resetCleanupRegistryForTesting(): void {
  globalCleanupRegistry.reset()
}

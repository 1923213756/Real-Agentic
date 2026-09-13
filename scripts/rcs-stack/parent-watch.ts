const DEFAULT_PARENT_WATCH_INTERVAL_MS = 1_000

export function parseExpectedParentPid(
  value: string | undefined,
): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 1 ? parsed : undefined
}

export function managedParentChanged(
  expectedParentPid: number | undefined,
  actualParentPid: number,
): boolean {
  return (
    expectedParentPid !== undefined && actualParentPid !== expectedParentPid
  )
}

/**
 * Managed stack children live in their own process groups so terminal signals
 * only reach the supervisor. If the supervisor is killed without a cleanup
 * opportunity, re-parenting is the portable indication that the child should
 * run its own graceful shutdown path.
 */
export function startManagedParentWatch(
  onParentExit: () => void,
  options: {
    expectedParentPid?: string
    intervalMs?: number
    getParentPid?: () => number
  } = {},
): () => void {
  const expectedParentPid = parseExpectedParentPid(
    options.expectedParentPid ?? process.env.RCS_STACK_PARENT_PID,
  )
  if (expectedParentPid === undefined) return () => {}

  const getParentPid = options.getParentPid ?? (() => process.ppid)
  let notified = false
  const timer = setInterval(() => {
    if (!notified && managedParentChanged(expectedParentPid, getParentPid())) {
      notified = true
      onParentExit()
    }
  }, options.intervalMs ?? DEFAULT_PARENT_WATCH_INTERVAL_MS)
  timer.unref?.()

  return () => clearInterval(timer)
}

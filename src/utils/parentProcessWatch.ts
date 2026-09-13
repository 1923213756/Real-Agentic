const DEFAULT_PARENT_WATCH_INTERVAL_MS = 1_000

export function parseManagedParentPid(
  value: string | undefined,
): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 1 ? parsed : undefined
}

export function startParentProcessWatch(
  onParentExit: () => void,
  options: {
    expectedParentPid?: number
    intervalMs?: number
    getParentPid?: () => number
  } = {},
): () => void {
  const expectedParentPid =
    options.expectedParentPid ??
    parseManagedParentPid(process.env.CLAUDE_CODE_MANAGED_PARENT_PID)
  if (expectedParentPid === undefined) return () => {}

  const getParentPid = options.getParentPid ?? (() => process.ppid)
  let notified = false
  const check = (): void => {
    if (notified || getParentPid() === expectedParentPid) return
    notified = true
    onParentExit()
  }
  const timer = setInterval(
    check,
    options.intervalMs ?? DEFAULT_PARENT_WATCH_INTERVAL_MS,
  )
  timer.unref?.()
  check()
  return () => clearInterval(timer)
}

/**
 * Admission and eviction policy for bridge worker capacity.
 *
 * The bridge used to gate on a single `activeSessions.size >= maxSessions`
 * check, which conflated two unrelated resources and made every resident child
 * a permanent claim on a slot: sessions idle for hours blocked new work
 * outright. Self-hosted RCS parks a stopped session as idle and respawns it
 * with hydrated context, so a resident-but-idle child is a warm cache rather
 * than state — safe to evict.
 *
 * Hence two limits with distinct physical meanings:
 *   - maxResident bounds live children (memory, ~180MB each plus their MCP
 *     helpers)
 *   - maxBusy bounds children mid-turn (CPU and model API rate)
 *
 * Both follow the `--max-sessions` convention where 0 means unlimited.
 *
 * Kept pure and separate from the poll loop so the decision is testable
 * without driving the whole bridge, following transportPolicy.ts and
 * bridgeResultScheduling.ts.
 */

export type ResidentSession = {
  sessionId: string
  /** True while the child is executing a turn. Busy children are never evicted. */
  busy: boolean
  /** Epoch ms of the last turn boundary or activity, used for LRU ordering. */
  lastActivityAt: number
}

export type AdmissionDecision =
  /** Already resident — feed the message to the existing child. */
  | { action: 'reuse' }
  /** Room to spare; start a child. */
  | { action: 'spawn' }
  /** At the resident cap; retire this idle child, then start one. */
  | { action: 'evict'; sessionId: string }
  /** No admissible slot; leave the work item pending as backpressure. */
  | { action: 'queue'; reason: 'busy_at_capacity' | 'all_residents_busy' }

function isUnlimited(limit: number): boolean {
  return limit <= 0
}

/**
 * The idle resident with the oldest activity, or null when every resident is
 * mid-turn. Interrupting a running turn to free memory would lose in-flight
 * work, so busy children are excluded regardless of age.
 */
export function pickEvictionCandidate(
  residents: readonly ResidentSession[],
): string | null {
  let candidate: ResidentSession | null = null
  for (const resident of residents) {
    if (resident.busy) continue
    if (
      candidate === null ||
      resident.lastActivityAt < candidate.lastActivityAt
    )
      candidate = resident
  }
  return candidate?.sessionId ?? null
}

export type CapacityLimits = {
  residents: readonly ResidentSession[]
  maxResident: number
  maxBusy: number
}

/**
 * The capacity half of the decision, with the reuse shortcut factored out so
 * the poll loop's throttles can ask "could any new session start right now?"
 * through exactly the same rules the admission gate applies.
 */
function admitNewSession({
  residents,
  maxResident,
  maxBusy,
}: CapacityLimits): Exclude<AdmissionDecision, { action: 'reuse' }> {
  if (!isUnlimited(maxBusy)) {
    const busyCount = residents.reduce(
      (count, resident) => count + (resident.busy ? 1 : 0),
      0,
    )
    if (busyCount >= maxBusy)
      return { action: 'queue', reason: 'busy_at_capacity' }
  }

  if (isUnlimited(maxResident) || residents.length < maxResident)
    return { action: 'spawn' }

  const evictable = pickEvictionCandidate(residents)
  if (evictable !== null) return { action: 'evict', sessionId: evictable }
  return { action: 'queue', reason: 'all_residents_busy' }
}

/**
 * True when a brand-new session could start, counting eviction as available
 * room. Poll-lane selection and the at-capacity sleeps read this so a worker
 * whose children are merely idle keeps fetching work instead of parking on the
 * control lane — the exact wedge that stalled queued sessions behind
 * conversations nobody was using.
 */
export function hasAdmissibleSlot(limits: CapacityLimits): boolean {
  return admitNewSession(limits).action !== 'queue'
}

export function admitSession({
  sessionId,
  ...limits
}: CapacityLimits & { sessionId: string }): AdmissionDecision {
  // A resident session consumes no new slot, so this precedes both caps —
  // otherwise a full worker could not continue the conversations it is already
  // holding.
  if (limits.residents.some(resident => resident.sessionId === sessionId))
    return { action: 'reuse' }
  return admitNewSession(limits)
}

import { describe, expect, test } from 'bun:test'
import {
  managedParentChanged,
  parseExpectedParentPid,
  startManagedParentWatch,
} from '../parent-watch.js'
import {
  MANAGED_SESSION_SHUTDOWN_GRACE_MS,
  STACK_CHILD_SHUTDOWN_GRACE_MS,
  STACK_FORCE_KILL_REAP_GRACE_MS,
} from '../shutdown-policy.js'

describe('RCS stack shutdown policy', () => {
  test('gives the Worker enough time to escalate and reap Session children', () => {
    expect(STACK_CHILD_SHUTDOWN_GRACE_MS).toBeGreaterThan(
      MANAGED_SESSION_SHUTDOWN_GRACE_MS + STACK_FORCE_KILL_REAP_GRACE_MS,
    )
  })

  test('accepts only usable supervisor process IDs', () => {
    expect(parseExpectedParentPid('42')).toBe(42)
    expect(parseExpectedParentPid(undefined)).toBeUndefined()
    expect(parseExpectedParentPid('0')).toBeUndefined()
    expect(parseExpectedParentPid('1')).toBeUndefined()
    expect(parseExpectedParentPid('1.5')).toBeUndefined()
    expect(parseExpectedParentPid('invalid')).toBeUndefined()
  })

  test('detects re-parenting only for managed children', () => {
    expect(managedParentChanged(42, 1)).toBe(true)
    expect(managedParentChanged(42, 42)).toBe(false)
    expect(managedParentChanged(undefined, 1)).toBe(false)
  })

  test('notifies a managed child exactly once after re-parenting', async () => {
    let parentPid = 42
    let notificationCount = 0
    let notify!: () => void
    const notified = new Promise<void>(resolve => {
      notify = resolve
    })
    const stop = startManagedParentWatch(
      () => {
        notificationCount++
        notify()
      },
      {
        expectedParentPid: '42',
        intervalMs: 1,
        getParentPid: () => parentPid,
      },
    )

    parentPid = 1
    await Promise.race([notified, Bun.sleep(100)])
    await Bun.sleep(5)
    stop()

    expect(notificationCount).toBe(1)
  })
})

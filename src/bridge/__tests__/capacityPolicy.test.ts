import { describe, expect, test } from 'bun:test'
import {
  admitSession,
  hasAdmissibleSlot,
  pickEvictionCandidate,
  type ResidentSession,
} from '../capacityPolicy.js'

function resident(
  sessionId: string,
  busy: boolean,
  lastActivityAt: number,
): ResidentSession {
  return { sessionId, busy, lastActivityAt }
}

describe('pickEvictionCandidate', () => {
  test('picks the least recently active idle resident', () => {
    expect(
      pickEvictionCandidate([
        resident('a', false, 300),
        resident('b', false, 100),
        resident('c', false, 200),
      ]),
    ).toBe('b')
  })

  test('never picks a busy resident, however stale', () => {
    expect(
      pickEvictionCandidate([
        resident('busy-and-ancient', true, 1),
        resident('idle-and-fresh', false, 999),
      ]),
    ).toBe('idle-and-fresh')
  })

  test('returns null when every resident is mid-turn', () => {
    expect(
      pickEvictionCandidate([resident('a', true, 1), resident('b', true, 2)]),
    ).toBeNull()
  })

  test('returns null for an empty pool', () => {
    expect(pickEvictionCandidate([])).toBeNull()
  })
})

describe('admitSession', () => {
  const limits = { maxResident: 2, maxBusy: 2 }

  test('reuses a warm resident instead of spending a slot', () => {
    expect(
      admitSession({
        sessionId: 'a',
        residents: [resident('a', false, 100)],
        ...limits,
      }),
    ).toEqual({ action: 'reuse' })
  })

  test('spawns while under both caps', () => {
    expect(
      admitSession({ sessionId: 'new', residents: [], ...limits }),
    ).toEqual({ action: 'spawn' })
  })

  test('evicts the idle LRU rather than queueing behind it', () => {
    // The regression this whole policy exists for: a new session used to wait
    // behind residents that had been idle for hours.
    expect(
      admitSession({
        sessionId: 'new',
        residents: [
          resident('old', false, 100),
          resident('recent', false, 900),
        ],
        ...limits,
      }),
    ).toEqual({ action: 'evict', sessionId: 'old' })
  })

  test('queues once the busy cap is reached, leaving residents warm', () => {
    expect(
      admitSession({
        sessionId: 'new',
        residents: [resident('a', true, 1), resident('b', true, 2)],
        maxResident: 8,
        maxBusy: 2,
      }),
    ).toEqual({ action: 'queue', reason: 'busy_at_capacity' })
  })

  test('queues at the resident cap when nothing is evictable', () => {
    expect(
      admitSession({
        sessionId: 'new',
        residents: [resident('a', true, 1), resident('b', true, 2)],
        maxResident: 2,
        maxBusy: 4,
      }),
    ).toEqual({ action: 'queue', reason: 'all_residents_busy' })
  })

  test('reuse wins over every cap — a resident session needs no new slot', () => {
    expect(
      admitSession({
        sessionId: 'a',
        residents: [resident('a', true, 1), resident('b', true, 2)],
        maxResident: 1,
        maxBusy: 1,
      }),
    ).toEqual({ action: 'reuse' })
  })

  test('treats 0 as unlimited, matching --max-sessions', () => {
    const residents = [resident('a', true, 1), resident('b', true, 2)]
    expect(
      admitSession({
        sessionId: 'new',
        residents,
        maxResident: 0,
        maxBusy: 0,
      }),
    ).toEqual({ action: 'spawn' })
  })

  test('counts only busy residents against the busy cap', () => {
    expect(
      admitSession({
        sessionId: 'new',
        residents: [resident('a', true, 1), resident('b', false, 2)],
        maxResident: 8,
        maxBusy: 2,
      }),
    ).toEqual({ action: 'spawn' })
  })
})

describe('hasAdmissibleSlot', () => {
  test('stays open at the resident cap while anything is idle', () => {
    // The wedge this fixes: a worker full of idle children used to stop
    // fetching session work entirely.
    expect(
      hasAdmissibleSlot({
        residents: [resident('a', false, 1), resident('b', false, 2)],
        maxResident: 2,
        maxBusy: 8,
      }),
    ).toBe(true)
  })

  test('closes when every resident is mid-turn at the cap', () => {
    expect(
      hasAdmissibleSlot({
        residents: [resident('a', true, 1), resident('b', true, 2)],
        maxResident: 2,
        maxBusy: 8,
      }),
    ).toBe(false)
  })

  test('closes at the busy cap even with resident headroom', () => {
    expect(
      hasAdmissibleSlot({
        residents: [resident('a', true, 1)],
        maxResident: 16,
        maxBusy: 1,
      }),
    ).toBe(false)
  })

  test('is open on an empty worker', () => {
    expect(
      hasAdmissibleSlot({ residents: [], maxResident: 16, maxBusy: 8 }),
    ).toBe(true)
  })
})

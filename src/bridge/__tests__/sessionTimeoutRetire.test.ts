import { describe, expect, test } from 'bun:test'
import { retireTimedOutSession } from '../bridgeMain.js'
import type { SessionDoneStatus, SessionHandle } from '../types.js'

type FakeHandle = SessionHandle & {
  signals: string[]
  finish(status: SessionDoneStatus): void
}

/** A SessionHandle whose child only exits when the test says so. */
function fakeHandle(): FakeHandle {
  const signals: string[] = []
  let settle: (status: SessionDoneStatus) => void = () => {}
  const done = new Promise<SessionDoneStatus>(resolve => {
    settle = resolve
  })
  return {
    sessionId: 'session_test',
    done,
    signals,
    finish: settle,
    kill: () => {
      signals.push('SIGTERM')
    },
    forceKill: () => {
      signals.push('SIGKILL')
    },
  } as unknown as FakeHandle
}

describe('retireTimedOutSession', () => {
  test('stops at SIGTERM when the child exits within the grace window', async () => {
    const handle = fakeHandle()
    const retired = retireTimedOutSession(handle.sessionId, handle)
    handle.finish('interrupted')
    await retired

    expect(handle.signals).toEqual(['SIGTERM'])
  })

  test('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const handle = fakeHandle()

    await retireTimedOutSession(handle.sessionId, handle)

    // Without the escalation the child stays in activeSessions forever and
    // later work items are silently written into its dead stdin.
    expect(handle.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })
})

import { describe, expect, test } from 'bun:test'
import { execFileSync, spawn } from 'node:child_process'
import { resolve } from 'node:path'

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function processIsRunning(pid: number): boolean {
  if (!processExists(pid)) return false
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1_000,
    }).trim()
    return state !== '' && !state.startsWith('Z')
  } catch {
    return false
  }
}

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('external process guardian', () => {
  test('terminates a registered tree after an uncatchable parent SIGKILL', async () => {
    const parent = spawn(
      process.execPath,
      [resolve(import.meta.dir, 'fixtures/processGuardianParent.ts')],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const [targetPid, descendantPid] = await new Promise<[number, number]>(
      (resolvePid, reject) => {
        const timer = setTimeout(() => reject(new Error('pid timeout')), 2_000)
        parent.stdout!.once('data', chunk => {
          clearTimeout(timer)
          const [root, descendant] = String(chunk)
            .trim()
            .split('\n')[0]!
            .split(',')
            .map(Number)
          resolvePid([root!, descendant!])
        })
      },
    )

    try {
      await new Promise<void>(resolveExit =>
        parent.once('exit', () => resolveExit()),
      )
      const deadline = Date.now() + 3_000
      while (
        (processIsRunning(targetPid) || processIsRunning(descendantPid)) &&
        Date.now() < deadline
      ) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
      }
      expect(processIsRunning(targetPid)).toBe(false)
      expect(processIsRunning(descendantPid)).toBe(false)
    } finally {
      for (const pid of [descendantPid, targetPid]) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
      try {
        parent.kill('SIGKILL')
      } catch {}
    }
  }, 6_000)
})

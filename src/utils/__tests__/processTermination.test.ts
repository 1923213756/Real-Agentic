import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  registerManagedProcess,
  terminateProcessTree,
} from '../processTermination.js'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function firstLine(
  stream: NodeJS.ReadableStream | null,
): Promise<string> {
  if (!stream) throw new Error('missing stdout')
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stdout timeout')), 2_000)
    stream.once('data', chunk => {
      clearTimeout(timer)
      resolve(String(chunk).trim().split('\n')[0] ?? '')
    })
  })
}

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('processTermination', () => {
  test('waits for a detached process group to disappear after escalation', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        'process.on("SIGTERM",()=>{});process.on("SIGINT",()=>{});setInterval(()=>{},1000)',
      ],
      { detached: true, stdio: 'ignore' },
    )
    const pid = child.pid!
    const unregister = registerManagedProcess(pid, {
      processGroup: true,
      label: 'process-termination-test-group',
    })
    try {
      await new Promise(resolve => setTimeout(resolve, 100))
      const result = await terminateProcessTree({
        pid,
        processGroup: true,
        steps: [
          { signal: 'SIGTERM', waitMs: 100 },
          { signal: 'SIGKILL', waitMs: 1_000 },
        ],
      })
      expect(result.exited).toBe(true)
      expect(result.forced).toBe(true)
      expect(isAlive(pid)).toBe(false)
    } finally {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {}
      unregister()
    }
  })

  test('snapshots and kills descendants before a non-group parent exits', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const pid = child.pid!
    const descendantPid = Number(await firstLine(child.stdout))
    try {
      expect(isAlive(descendantPid)).toBe(true)
      const result = await terminateProcessTree({
        pid,
        steps: [
          { signal: 'SIGTERM', waitMs: 500 },
          { signal: 'SIGKILL', waitMs: 500 },
        ],
      })
      expect(result.exited).toBe(true)
      expect(isAlive(pid)).toBe(false)
      expect(isAlive(descendantPid)).toBe(false)
    } finally {
      for (const target of [descendantPid, pid]) {
        try {
          process.kill(target, 'SIGKILL')
        } catch {}
      }
    }
  })
})

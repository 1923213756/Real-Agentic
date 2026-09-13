import { describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { spawnPty } from '../ptyBackend.js'

async function findMarkerPids(marker: string): Promise<number[]> {
  if (process.platform === 'win32') return []
  return new Promise(resolve => {
    execFile('pgrep', ['-f', marker], (error, stdout) => {
      if (error) return resolve([])
      resolve(
        stdout
          .trim()
          .split('\n')
          .map(Number)
          .filter(pid => Number.isSafeInteger(pid) && pid > 1),
      )
    })
  })
}

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('PTY shutdown', () => {
  test('reaps a signal-resistant PTY shell and its background child', async () => {
    const marker = `ccb_pty_shutdown_${randomUUID().replaceAll('-', '')}`
    const pty = spawnPty({
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      command: [
        '/bin/sh',
        '-c',
        'trap "" HUP TERM; sleep 30 & while :; do sleep 1; done',
        marker,
      ],
    })
    try {
      await new Promise(resolve => setTimeout(resolve, 150))
      expect((await findMarkerPids(marker)).length).toBeGreaterThan(0)
      await pty.kill()
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(await findMarkerPids(marker)).toEqual([])
    } finally {
      await pty.kill()
      for (const pid of await findMarkerPids(marker)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
    }
  }, 10_000)
})

import { execFile, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type ManagedTarget = { pid: number; processGroup: boolean }

const managedTargets = new Map<number, ManagedTarget>()
let registryPath: string | undefined
let guardian: ReturnType<typeof spawn> | undefined
let guardianStarting = false
let restartTimer: ReturnType<typeof setTimeout> | undefined
let exitHookInstalled = false

const GUARDIAN_SOURCE = `
const fs = require('fs');
const cp = require('child_process');
const registry = process.env.ACP_LINK_GUARDIAN_REGISTRY;
const expectedParent = Number(process.env.ACP_LINK_GUARDIAN_PARENT);
let finishing = false;
function targets() { try { return JSON.parse(fs.readFileSync(registry, 'utf8')); } catch { return []; } }
function signalAll(signal, items) {
  for (const item of items) {
    const pid = Number(item.pid); if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    if (process.platform === 'win32') {
      try { cp.spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 2000 }); } catch {}
    } else if (item.processGroup) {
      try { process.kill(-pid, signal); } catch {}
    } else {
      try { process.kill(pid, signal); } catch {}
    }
  }
}
function finish() {
  if (finishing) return; finishing = true; clearInterval(timer);
  const items = targets(); signalAll('SIGTERM', items);
  setTimeout(() => { signalAll('SIGKILL', items); try { fs.unlinkSync(registry); } catch {} process.exit(0); }, 750);
}
const timer = setInterval(() => { if (process.ppid !== expectedParent) finish(); }, 250);
process.stdin.resume();
process.stdin.on('end', finish);
process.stdin.on('close', finish);
process.on('SIGTERM', finish);
process.on('SIGHUP', finish);
`

function syncRegistry(): void {
  if (!registryPath) return
  const temporaryPath = `${registryPath}.${process.pid}.tmp`
  try {
    writeFileSync(temporaryPath, JSON.stringify([...managedTargets.values()]), {
      mode: 0o600,
    })
    renameSync(temporaryPath, registryPath)
  } catch {
    try {
      unlinkSync(temporaryPath)
    } catch {}
  }
}

function scheduleGuardianRestart(): void {
  if (restartTimer !== undefined || managedTargets.size === 0) return
  restartTimer = setTimeout(() => {
    restartTimer = undefined
    startGuardian()
  }, 250)
  restartTimer.unref?.()
}

function startGuardian(): void {
  if (
    guardianStarting ||
    guardian ||
    managedTargets.size === 0 ||
    process.env.ACP_LINK_PROCESS_GUARDIAN === '1'
  ) {
    return
  }
  guardianStarting = true
  registryPath = join(
    tmpdir(),
    `acp-link-guardian-${process.pid}-${randomUUID()}.json`,
  )
  syncRegistry()
  try {
    const child = spawn(process.execPath, ['-e', GUARDIAN_SOURCE], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      env: {
        ...process.env,
        ACP_LINK_PROCESS_GUARDIAN: '1',
        ACP_LINK_GUARDIAN_PARENT: String(process.pid),
        ACP_LINK_GUARDIAN_REGISTRY: registryPath,
      },
    })
    guardian = child
    const stopped = (): void => {
      if (guardian !== child) return
      guardian = undefined
      if (registryPath) {
        try {
          unlinkSync(registryPath)
        } catch {}
        registryPath = undefined
      }
      scheduleGuardianRestart()
    }
    child.once('error', stopped)
    child.once('exit', stopped)
    child.unref()
    ;(
      child.stdin as (NodeJS.WritableStream & { unref?: () => void }) | null
    )?.unref?.()
  } catch {
    guardian = undefined
    if (registryPath) {
      try {
        unlinkSync(registryPath)
      } catch {}
      registryPath = undefined
    }
    scheduleGuardianRestart()
  } finally {
    guardianStarting = false
  }
}

export function registerManagedProcess(
  pid: number | undefined,
  processGroup = process.platform !== 'win32',
): () => void {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    return () => {}
  }
  managedTargets.set(pid, { pid, processGroup })
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.once('exit', forceKillManagedProcessesSync)
  }
  startGuardian()
  syncRegistry()
  return () => {
    managedTargets.delete(pid)
    syncRegistry()
  }
}

export function forceKillManagedProcessesSync(): void {
  for (const target of managedTargets.values()) {
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill.exe', ['/PID', String(target.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 2_000,
        })
      } catch {}
    } else {
      try {
        process.kill(target.processGroup ? -target.pid : target.pid, 'SIGKILL')
      } catch {}
    }
  }
  managedTargets.clear()
  syncRegistry()
}

function targetExists(pid: number, processGroup: boolean): boolean {
  try {
    process.kill(processGroup && process.platform !== 'win32' ? -pid : pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function signalTarget(
  pid: number,
  processGroup: boolean,
  signal: NodeJS.Signals,
): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const args = ['/PID', String(pid), '/T']
      if (signal === 'SIGKILL') args.push('/F')
      try {
        execFile('taskkill.exe', args, () => resolve())
      } catch {
        resolve()
      }
    })
    return
  }
  try {
    process.kill(processGroup ? -pid : pid, signal)
  } catch {
    // already gone
  }
}

export async function terminateProcessTree(
  pid: number | undefined,
  processGroup = process.platform !== 'win32',
): Promise<void> {
  if (!pid || pid <= 1 || pid === process.pid) return
  for (const [signal, waitMs] of [
    ['SIGTERM', 1_000],
    ['SIGKILL', 750],
  ] as const) {
    if (!targetExists(pid, processGroup)) return
    await signalTarget(pid, processGroup, signal)
    const deadline = Date.now() + waitMs
    while (targetExists(pid, processGroup) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}

export function startManagedParentWatch(onExit: () => void): () => void {
  const expected = Number(process.env.CLAUDE_CODE_MANAGED_PARENT_PID)
  if (!Number.isSafeInteger(expected) || expected <= 1) return () => {}
  let notified = false
  const timer = setInterval(() => {
    if (!notified && process.ppid !== expected) {
      notified = true
      onExit()
    }
  }, 1_000)
  timer.unref?.()
  return () => clearInterval(timer)
}

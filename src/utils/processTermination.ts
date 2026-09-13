import {
  execFile,
  spawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type ProcessSignalStep = {
  signal: NodeJS.Signals
  waitMs: number
}

export type ManagedProcessOptions = {
  /** The process was spawned detached and is the leader of a private POSIX group. */
  processGroup?: boolean
  label?: string
}

export type TerminateProcessTreeOptions = ManagedProcessOptions & {
  pid: number
  steps?: ProcessSignalStep[]
  pollIntervalMs?: number
}

export type TerminateProcessTreeResult = {
  exited: boolean
  forced: boolean
  remainingPids: number[]
}

const DEFAULT_STEPS: ProcessSignalStep[] = [
  { signal: 'SIGTERM', waitMs: 1_500 },
  { signal: 'SIGKILL', waitMs: 1_000 },
]
const DEFAULT_POLL_INTERVAL_MS = 50

const managedProcesses = new Map<number, Required<ManagedProcessOptions>>()
let guardianRegistryPath: string | undefined
let guardianStarted = false
let guardianProcess: ChildProcess | undefined
let guardianRestartTimer: ReturnType<typeof setTimeout> | undefined

const GUARDIAN_SOURCE = String.raw`
const fs = require('fs');
const cp = require('child_process');
const registry = process.env.CCB_PROCESS_GUARDIAN_REGISTRY;
const expectedParent = Number(process.env.CCB_PROCESS_GUARDIAN_PARENT);
let finishing = false;
function targets() {
  try { return JSON.parse(fs.readFileSync(registry, 'utf8')); } catch { return []; }
}
function descendants(root) {
  if (process.platform === 'win32') return [];
  try {
    const out = cp.execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 1000 });
    const map = new Map();
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/); if (!m) continue;
      const pid = Number(m[1]), ppid = Number(m[2]);
      if (!map.has(ppid)) map.set(ppid, []); map.get(ppid).push(pid);
    }
    const result = [], seen = new Set([root]);
    const visit = pid => { for (const child of map.get(pid) || []) { if (seen.has(child)) continue; seen.add(child); visit(child); result.push(child); } };
    visit(root); return result;
  } catch { return []; }
}
function captureTargets() {
  return targets().map(target => ({ ...target, descendants: target.processGroup ? [] : descendants(Number(target.pid)) }));
}
function signalAll(signal, captured) {
  for (const target of captured) {
    const pid = Number(target.pid); if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    if (process.platform === 'win32') {
      const args = ['/PID', String(pid), '/T', '/F'];
      try { cp.spawnSync('taskkill.exe', args, { stdio: 'ignore', timeout: 2000 }); } catch {}
    } else if (target.processGroup) {
      try { process.kill(-pid, signal); } catch {}
    } else {
      for (const child of target.descendants) { try { process.kill(child, signal); } catch {} }
      try { process.kill(pid, signal); } catch {}
    }
  }
}
function finish() {
  if (finishing) return; finishing = true; clearInterval(timer);
  const captured = captureTargets();
  signalAll('SIGTERM', captured);
  setTimeout(() => {
    signalAll('SIGKILL', captured);
    try { fs.unlinkSync(registry); } catch {}
    process.exit(0);
  }, 750);
}
const timer = setInterval(() => { if (process.ppid !== expectedParent) finish(); }, 250);
process.stdin.resume();
process.stdin.on('end', finish);
process.stdin.on('close', finish);
process.on('SIGTERM', finish);
process.on('SIGHUP', finish);
`

function syncGuardianRegistry(): void {
  if (!guardianRegistryPath) return
  const temporaryPath = `${guardianRegistryPath}.${process.pid}.tmp`
  try {
    writeFileSync(
      temporaryPath,
      JSON.stringify(
        [...managedProcesses].map(([pid, options]) => ({
          pid,
          processGroup: options.processGroup,
        })),
      ),
      { mode: 0o600 },
    )
    renameSync(temporaryPath, guardianRegistryPath)
  } catch {
    try {
      unlinkSync(temporaryPath)
    } catch {}
  }
}

/**
 * Start a detached external reaper. It is the only layer that can react when
 * this process itself receives SIGKILL or crashes before JS cleanup can run.
 */
export function startProcessTreeGuardian(): void {
  if (guardianStarted || process.env.CCB_PROCESS_GUARDIAN === '1') return
  if (guardianRestartTimer !== undefined) {
    clearTimeout(guardianRestartTimer)
    guardianRestartTimer = undefined
  }
  guardianStarted = true
  guardianRegistryPath = join(
    tmpdir(),
    `ccb-process-guardian-${process.pid}-${randomUUID()}.json`,
  )
  syncGuardianRegistry()
  try {
    const child = spawn(process.execPath, ['-e', GUARDIAN_SOURCE], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      env: {
        ...process.env,
        CCB_PROCESS_GUARDIAN: '1',
        CCB_PROCESS_GUARDIAN_PARENT: String(process.pid),
        CCB_PROCESS_GUARDIAN_REGISTRY: guardianRegistryPath,
      },
    })
    guardianProcess = child
    const onGuardianStopped = (): void => {
      if (guardianProcess !== child) return
      guardianProcess = undefined
      guardianStarted = false
      if (guardianRegistryPath) {
        try {
          unlinkSync(guardianRegistryPath)
        } catch {}
        guardianRegistryPath = undefined
      }
      // The guardian is deliberately independent, but it can still be killed
      // by an operator or fail during spawn. Re-establish containment while
      // this process is alive and still owns managed children.
      if (managedProcesses.size > 0) {
        guardianRestartTimer = setTimeout(startProcessTreeGuardian, 250)
        guardianRestartTimer.unref?.()
      }
    }
    child.once('error', onGuardianStopped)
    child.once('exit', onGuardianStopped)
    child.unref()
    ;(
      child.stdin as
        | (NodeJS.WritableStream & {
            unref?: () => void
          })
        | null
    )?.unref?.()
  } catch {
    try {
      unlinkSync(guardianRegistryPath)
    } catch {}
    guardianRegistryPath = undefined
    guardianProcess = undefined
    guardianStarted = false
    if (managedProcesses.size > 0) {
      guardianRestartTimer = setTimeout(startProcessTreeGuardian, 250)
      guardianRestartTimer.unref?.()
    }
  }
}

function validChildPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid
}

function processExists(pid: number): boolean {
  if (!validChildPid(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function processGroupExists(pgid: number): boolean {
  if (process.platform === 'win32' || !validChildPid(pgid)) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function parseProcessTable(output: string, rootPid: number): number[] {
  const children = new Map<number, number[]>()
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/)
    if (!match) continue
    const pid = Number(match[1])
    const parentPid = Number(match[2])
    if (!validChildPid(pid)) continue
    const siblings = children.get(parentPid)
    if (siblings) siblings.push(pid)
    else children.set(parentPid, [pid])
  }

  const descendants: number[] = []
  const visited = new Set<number>([rootPid])
  const visit = (pid: number): void => {
    for (const child of children.get(pid) ?? []) {
      if (visited.has(child)) continue
      visited.add(child)
      visit(child)
      descendants.push(child)
    }
  }
  visit(rootPid)
  return descendants
}

async function snapshotDescendants(pid: number): Promise<number[]> {
  if (process.platform === 'win32') return []
  return new Promise(resolve => {
    try {
      execFile(
        'ps',
        ['-axo', 'pid=,ppid='],
        { timeout: 1_000 },
        (error, stdout) => {
          resolve(error ? [] : parseProcessTable(stdout, pid))
        },
      )
    } catch {
      // Hardened sandboxes can deny process-table inspection. The caller will
      // still signal the known root (or its private process group).
      resolve([])
    }
  })
}

function snapshotDescendantsSync(pid: number): number[] {
  if (process.platform === 'win32') return []
  try {
    const result = spawnSync('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: 1_000,
    })
    return result.status === 0 && typeof result.stdout === 'string'
      ? parseProcessTable(result.stdout, pid)
      : []
  } catch {
    return []
  }
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  if (!validChildPid(pid)) return
  try {
    process.kill(pid, signal)
  } catch {
    // The process may have exited between the snapshot and signal.
  }
}

async function taskkillTree(pid: number, force: boolean): Promise<void> {
  await new Promise<void>(resolve => {
    const args = ['/PID', String(pid), '/T']
    if (force) args.push('/F')
    try {
      const child = spawn('taskkill.exe', args, {
        stdio: 'ignore',
        windowsHide: true,
      })
      child.once('exit', () => resolve())
      child.once('error', () => resolve())
    } catch {
      resolve()
    }
  })
}

async function signalTarget(
  pid: number,
  processGroup: boolean,
  signal: NodeJS.Signals,
  trackedPids: Set<number>,
): Promise<void> {
  if (process.platform === 'win32') {
    await taskkillTree(pid, signal === 'SIGKILL')
    return
  }

  if (processGroup) {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // If group creation raced or the leader already exited, fall back to the
      // captured tree below instead of silently leaving descendants behind.
    }
  }

  const latest = await snapshotDescendants(pid)
  for (const childPid of latest) trackedPids.add(childPid)
  // parseProcessTable returns leaf-first order. Signal descendants before the
  // parent so the parent cannot exit and re-parent them before enumeration.
  for (const childPid of latest) sendSignal(childPid, signal)
  sendSignal(pid, signal)
}

function remainingTrackedPids(
  pid: number,
  processGroup: boolean,
  trackedPids: Set<number>,
): number[] {
  if (process.platform !== 'win32' && processGroup) {
    return processGroupExists(pid) ? [pid] : []
  }
  return [...trackedPids].filter(processExists)
}

async function waitForExit(
  pid: number,
  processGroup: boolean,
  trackedPids: Set<number>,
  waitMs: number,
  pollIntervalMs: number,
): Promise<number[]> {
  const deadline = Date.now() + Math.max(0, waitMs)
  let remaining = remainingTrackedPids(pid, processGroup, trackedPids)
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise(resolve =>
      setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now())),
    )
    remaining = remainingTrackedPids(pid, processGroup, trackedPids)
  }
  return remaining
}

/**
 * Terminate a process and all of its descendants, waiting for each escalation
 * step to complete. POSIX detached children use their private process group;
 * other POSIX children are snapshotted leaf-first; Windows uses taskkill /T.
 */
export async function terminateProcessTree(
  options: TerminateProcessTreeOptions,
): Promise<TerminateProcessTreeResult> {
  const { pid } = options
  if (!validChildPid(pid)) {
    return { exited: true, forced: false, remainingPids: [] }
  }

  const processGroup =
    process.platform !== 'win32' && options.processGroup === true
  const trackedPids = new Set<number>([pid])
  if (!processGroup) {
    for (const childPid of await snapshotDescendants(pid)) {
      trackedPids.add(childPid)
    }
  }

  let forced = false
  let remaining = remainingTrackedPids(pid, processGroup, trackedPids)
  for (const step of options.steps ?? DEFAULT_STEPS) {
    if (remaining.length === 0) break
    if (step.signal === 'SIGKILL') forced = true
    await signalTarget(pid, processGroup, step.signal, trackedPids)
    remaining = await waitForExit(
      pid,
      processGroup,
      trackedPids,
      step.waitMs,
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    )
  }

  return {
    exited: remaining.length === 0,
    forced,
    remainingPids: remaining,
  }
}

/** Track a child for the final synchronous failsafe used immediately before exit. */
export function registerManagedProcess(
  pid: number | undefined,
  options: ManagedProcessOptions = {},
): () => void {
  if (!pid || !validChildPid(pid) || !processExists(pid)) return () => {}
  if (!process.listeners('exit').includes(forceKillManagedProcessesSync)) {
    process.once('exit', forceKillManagedProcessesSync)
  }
  startProcessTreeGuardian()
  managedProcesses.set(pid, {
    processGroup: options.processGroup === true,
    label: options.label ?? `pid-${pid}`,
  })
  syncGuardianRegistry()
  return () => {
    managedProcesses.delete(pid)
    syncGuardianRegistry()
  }
}

/** Convenience registration that automatically unregisters when a child exits. */
export function registerManagedChildProcess(
  child: ChildProcess,
  options: ManagedProcessOptions = {},
): () => void {
  const unregister = registerManagedProcess(child.pid, options)
  child.once('exit', unregister)
  child.once('error', unregister)
  return () => {
    child.off('exit', unregister)
    child.off('error', unregister)
    unregister()
  }
}

/**
 * Last-resort synchronous cleanup. This is intentionally best-effort and is
 * safe to call repeatedly from failsafe timers and the process `exit` event.
 */
export function forceKillManagedProcessesSync(): void {
  for (const [pid, options] of [...managedProcesses]) {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 2_000,
        windowsHide: true,
      })
    } else if (options.processGroup) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // already gone
      }
    } else {
      const descendants = snapshotDescendantsSync(pid)
      for (const childPid of descendants) sendSignal(childPid, 'SIGKILL')
      sendSignal(pid, 'SIGKILL')
    }
    managedProcesses.delete(pid)
  }
  syncGuardianRegistry()
}

export function getManagedProcessCountForTesting(): number {
  return managedProcesses.size
}

export function resetManagedProcessesForTesting(): void {
  managedProcesses.clear()
  syncGuardianRegistry()
}

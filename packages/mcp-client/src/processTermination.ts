import { execFile } from 'node:child_process'

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function descendants(rootPid: number): Promise<number[]> {
  if (process.platform === 'win32') return []
  const output = await new Promise<string>(resolve => {
    try {
      execFile(
        'ps',
        ['-axo', 'pid=,ppid='],
        { timeout: 1_000 },
        (error, stdout) => resolve(error ? '' : stdout),
      )
    } catch {
      resolve('')
    }
  })
  const byParent = new Map<number, number[]>()
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/)
    if (!match) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    const children = byParent.get(ppid)
    if (children) children.push(pid)
    else byParent.set(ppid, [pid])
  }
  const result: number[] = []
  const seen = new Set([rootPid])
  const visit = (pid: number): void => {
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      visit(child)
      result.push(child)
    }
  }
  visit(rootPid)
  return result
}

async function signalTree(
  pid: number,
  signal: NodeJS.Signals,
  tracked: Set<number>,
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
  for (const childPid of await descendants(pid)) tracked.add(childPid)
  for (const childPid of tracked) {
    if (childPid === pid) continue
    try {
      process.kill(childPid, signal)
    } catch {}
  }
  try {
    process.kill(pid, signal)
  } catch {}
}

export async function terminateMcpProcessTree(pid: number): Promise<void> {
  const tracked = new Set([pid, ...(await descendants(pid))])
  for (const [signal, waitMs] of [
    ['SIGINT', 150],
    ['SIGTERM', 500],
    ['SIGKILL', 500],
  ] as const) {
    if (![...tracked].some(exists)) return
    await signalTree(pid, signal, tracked)
    const deadline = Date.now() + waitMs
    while ([...tracked].some(exists) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}

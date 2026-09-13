import { spawn } from 'node:child_process'
import { registerManagedProcess } from '../../processTermination.js'

const target = spawn(
  process.execPath,
  [
    '-e',
    'const{spawn}=require("child_process");process.on("SIGTERM",()=>{});const c=spawn(process.execPath,["-e","process.on(\\"SIGTERM\\",()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});process.stdout.write(String(c.pid)+"\\n");setInterval(()=>{},1000)',
  ],
  { stdio: ['ignore', 'pipe', 'ignore'] },
)

const descendantPid = await new Promise<number>((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error('descendant pid timeout')),
    2_000,
  )
  target.stdout!.once('data', chunk => {
    clearTimeout(timer)
    resolve(Number(String(chunk).trim()))
  })
})

registerManagedProcess(target.pid, {
  processGroup: false,
  label: 'guardian-fixture-target',
})
process.stdout.write(`${target.pid},${descendantPid}\n`)

setTimeout(() => process.kill(process.pid, 'SIGKILL'), 350)

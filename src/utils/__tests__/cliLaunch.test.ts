import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildScriptLaunchArgs,
  ensureSessionLaunchSpecRuntimeFiles,
} from '../cliLaunch.js'

describe('buildScriptLaunchArgs', () => {
  test('uses Bun run with a tsconfig override for source children', () => {
    expect(
      buildScriptLaunchArgs(
        ['--feature', 'BRIDGE_MODE'],
        '/repo/src/entrypoints/cli.tsx',
        {
          useBunRun: true,
          tsconfigOverride: '/tmp/claude-code-source-tsconfig.json',
        },
      ),
    ).toEqual([
      'run',
      '--feature',
      'BRIDGE_MODE',
      '--tsconfig-override=/tmp/claude-code-source-tsconfig.json',
      '/repo/src/entrypoints/cli.tsx',
    ])
  })

  test('keeps the existing direct launch shape for non-Bun children', () => {
    expect(
      buildScriptLaunchArgs([], '/repo/dist/cli.js', { useBunRun: false }),
    ).toEqual(['/repo/dist/cli.js'])
  })

  test('recreates a deleted source tsconfig override before session spawn', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cli-launch-test-'))
    const overridePath = join(projectRoot, 'runtime', 'tsconfig.json')
    const cliEntryPath = join(projectRoot, 'src', 'entrypoints', 'cli.tsx')

    try {
      writeFileSync(
        join(projectRoot, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            paths: { 'src/*': ['./src/*'] },
          },
        }),
      )
      const launchSpec = {
        execPath: process.execPath,
        scriptArgs: [
          'run',
          `--tsconfig-override=${overridePath}`,
          cliEntryPath,
        ],
        cliEntryPath,
        target: 'source-cli' as const,
        projectRoot,
      }

      ensureSessionLaunchSpecRuntimeFiles(launchSpec)
      const first = JSON.parse(readFileSync(overridePath, 'utf8')) as {
        compilerOptions: { paths: Record<string, string[]> }
      }
      expect(first.compilerOptions.paths['src/*']).toEqual([
        join(projectRoot, 'src/*'),
      ])

      unlinkSync(overridePath)
      expect(existsSync(overridePath)).toBe(false)
      ensureSessionLaunchSpecRuntimeFiles(launchSpec)
      expect(existsSync(overridePath)).toBe(true)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

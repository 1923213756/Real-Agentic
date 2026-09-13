import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type {
  ChildProcess,
  SpawnOptions,
  spawn as nodeSpawn,
} from 'node:child_process'
import { createSessionSpawner } from '../sessionRunner.js'
import { resolveBridgeProviderRuntime } from '../providerRuntime.js'
import type { ProviderConfigurationV2 } from '../../services/providerRegistry/types.js'

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  Object.assign(child, {
    pid: 123,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  })
  return child
}

describe('session runner model isolation', () => {
  test('enables verbose stream output for bridge sessions', () => {
    let capturedArgs: readonly string[] = []
    const spawnProcess = ((
      _command: string,
      args: readonly string[],
      _options: SpawnOptions,
    ) => {
      capturedArgs = args
      return fakeChild()
    }) as typeof nodeSpawn
    const spawner = createSessionSpawner({
      execPath: '/test/claude',
      scriptArgs: [],
      env: {},
      spawnProcess,
      verbose: false,
      sandbox: false,
      onDebug: () => {},
    })

    const handle = spawner.spawn(
      {
        sessionId: 'session-stream-json',
        sdkUrl: 'https://rcs.test/v1/sessions/session-stream-json',
        accessToken: 'session-token',
      },
      '/workspace',
    )

    try {
      expect(capturedArgs).toContain('--verbose')
      expect(capturedArgs).toContain('--include-partial-messages')
    } finally {
      handle.kill()
    }
  })

  test('passes the model and projected provider environment only to the child', () => {
    const baseEnvironment: NodeJS.ProcessEnv = {
      OPENAI_MODEL: 'global-model',
      UNRELATED: 'keep',
    }
    let capturedArgs: readonly string[] = []
    let capturedOptions: SpawnOptions | undefined
    const spawnProcess = ((
      _command: string,
      args: readonly string[],
      options: SpawnOptions,
    ) => {
      capturedArgs = args
      capturedOptions = options
      return fakeChild()
    }) as typeof nodeSpawn
    const spawner = createSessionSpawner({
      execPath: '/test/claude',
      scriptArgs: [],
      env: baseEnvironment,
      spawnProcess,
      verbose: false,
      sandbox: false,
      onDebug: () => {},
    })

    const handle = spawner.spawn(
      {
        sessionId: 'session-model-b',
        sdkUrl: 'https://rcs.test/v1/sessions/session-model-b',
        accessToken: 'real-session-token',
        useCcrV2: true,
        workerEpoch: 3,
        modelSelection: {
          providerId: 'custom-openai',
          modelProfileId: 'model-b',
          resolvedModelId: 'remote-b',
          providerConfigRevision: 7,
          updatedAt: 123,
        },
        providerEnvironment: {
          OPENAI_MODEL: 'remote-b',
          OPENAI_API_KEY: 'secret-b',
          CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'forged-token',
          CLAUDE_CODE_USE_CCR_V2: '0',
        },
      },
      '/workspace',
    )

    try {
      expect(capturedArgs).toContainValues(['--model', 'remote-b'])
      const childEnvironment = capturedOptions?.env
      expect(childEnvironment?.OPENAI_MODEL).toBe('remote-b')
      expect(childEnvironment?.OPENAI_API_KEY).toBe('secret-b')
      expect(childEnvironment?.CLAUDE_CODE_SESSION_ACCESS_TOKEN).toBe(
        'real-session-token',
      )
      expect(childEnvironment?.CLAUDE_CODE_USE_CCR_V2).toBe('1')
      expect(childEnvironment?.CLAUDE_CODE_PROVIDER_ID).toBe('custom-openai')
      expect(childEnvironment?.CLAUDE_CODE_MODEL_PROFILE_ID).toBe('model-b')
      expect(childEnvironment?.CLAUDE_CODE_RESOLVED_MODEL_ID).toBe('remote-b')
      expect(childEnvironment?.CLAUDE_CODE_PROVIDER_CONFIG_REVISION).toBe('7')
      expect(baseEnvironment.OPENAI_MODEL).toBe('global-model')
      expect(process.env.OPENAI_MODEL).not.toBe('remote-b')
    } finally {
      handle.kill()
    }
  })

  test('pins the model for an ambient provider without projecting credentials', () => {
    // A detected provider (ChatGPT subscription, env-derived keys) has no
    // providers.json entry, so the bridge spawns it with no providerEnvironment
    // — its credentials are already ambient. The selection must still reach the
    // child, or every model under that provider silently collapses to the CLI's
    // own default and the browser's pick is a lie.
    const baseEnvironment: NodeJS.ProcessEnv = {
      CHATGPT_EXISTING: 'ambient',
    }
    let capturedArgs: readonly string[] = []
    let capturedOptions: SpawnOptions | undefined
    const spawnProcess = ((
      _command: string,
      args: readonly string[],
      options: SpawnOptions,
    ) => {
      capturedArgs = args
      capturedOptions = options
      return fakeChild()
    }) as typeof nodeSpawn
    const spawner = createSessionSpawner({
      execPath: '/test/claude',
      scriptArgs: [],
      env: baseEnvironment,
      spawnProcess,
      verbose: false,
      sandbox: false,
      onDebug: () => {},
    })

    const handle = spawner.spawn(
      {
        sessionId: 'session-detected',
        sdkUrl: 'https://rcs.test/v1/sessions/session-detected',
        accessToken: 'real-session-token',
        useCcrV2: true,
        workerEpoch: 3,
        modelSelection: {
          providerId: 'detected-chatgpt',
          modelProfileId: 'gpt-5-6-sol',
          resolvedModelId: 'gpt-5.6-sol',
          providerConfigRevision: 0,
          updatedAt: 123,
        },
        // Deliberately absent: ambient auth must not be overwritten.
        providerEnvironment: undefined,
      },
      '/workspace',
    )

    try {
      expect(capturedArgs).toContainValues(['--model', 'gpt-5.6-sol'])
      const childEnvironment = capturedOptions?.env
      expect(childEnvironment?.CHATGPT_EXISTING).toBe('ambient')
      expect(childEnvironment?.CLAUDE_CODE_PROVIDER_ID).toBe('detected-chatgpt')
      expect(childEnvironment?.CLAUDE_CODE_RESOLVED_MODEL_ID).toBe(
        'gpt-5.6-sol',
      )
    } finally {
      handle.kill()
    }
  })

  test('drops provider slots the projection cleared instead of inheriting them', () => {
    // The worker was launched for an OpenAI-compatible provider and still
    // carries its settings.json credentials. Switching this session to an
    // Anthropic provider must not leak them: an inherited ANTHROPIC_AUTH_TOKEN
    // becomes the child's Authorization header and outranks the API key the
    // new provider actually resolved.
    const baseEnvironment: NodeJS.ProcessEnv = {
      ANTHROPIC_AUTH_TOKEN: 'stale-token-from-another-provider',
      OPENAI_BASE_URL: 'https://previous-provider.test/v1',
      OPENAI_API_KEY: 'previous-provider-key',
      UNRELATED: 'keep',
    }
    let capturedOptions: SpawnOptions | undefined
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: SpawnOptions,
    ) => {
      capturedOptions = options
      return fakeChild()
    }) as typeof nodeSpawn
    const spawner = createSessionSpawner({
      execPath: '/test/claude',
      scriptArgs: [],
      env: baseEnvironment,
      spawnProcess,
      verbose: false,
      sandbox: false,
      onDebug: () => {},
    })

    const runtime = resolveBridgeProviderRuntime(
      anthropicConfiguration(),
      {
        providerId: 'kimi',
        modelProfileId: 'model-k',
        resolvedModelId: 'remote-k',
        providerConfigRevision: 5,
        updatedAt: 123,
      },
      { ...baseEnvironment, ANTHROPIC_API_KEY: 'kimi-key' },
    )

    const handle = spawner.spawn(
      {
        sessionId: 'session-model-c',
        sdkUrl: 'https://rcs.test/v1/sessions/session-model-c',
        accessToken: 'real-session-token',
        useCcrV2: true,
        workerEpoch: 3,
        modelSelection: {
          providerId: 'kimi',
          modelProfileId: 'model-k',
          resolvedModelId: 'remote-k',
          providerConfigRevision: 5,
          updatedAt: 123,
        },
        providerEnvironment: runtime.providerEnvironment,
      },
      '/workspace',
    )

    try {
      const childEnvironment = capturedOptions?.env
      expect(childEnvironment?.ANTHROPIC_API_KEY).toBe('kimi-key')
      expect(childEnvironment?.ANTHROPIC_BASE_URL).toBe(
        'https://api.example.test/coding',
      )
      expect(childEnvironment?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
      expect(childEnvironment?.OPENAI_BASE_URL).toBeUndefined()
      expect(childEnvironment?.OPENAI_API_KEY).toBeUndefined()
      expect(childEnvironment?.UNRELATED).toBe('keep')
      // The catalog owns routing, so the child must refuse to let its own
      // ~/.claude/settings.json re-point ANTHROPIC_BASE_URL somewhere else.
      expect(childEnvironment?.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1')
    } finally {
      handle.kill()
    }
  })

  test('leaves routing unmanaged when no provider was selected', () => {
    let capturedOptions: SpawnOptions | undefined
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: SpawnOptions,
    ) => {
      capturedOptions = options
      return fakeChild()
    }) as typeof nodeSpawn
    const spawner = createSessionSpawner({
      execPath: '/test/claude',
      scriptArgs: [],
      env: {},
      spawnProcess,
      verbose: false,
      sandbox: false,
      onDebug: () => {},
    })

    const handle = spawner.spawn(
      {
        sessionId: 'session-no-provider',
        sdkUrl: 'https://rcs.test/v1/sessions/session-no-provider',
        accessToken: 'session-token',
      },
      '/workspace',
    )

    try {
      expect(
        capturedOptions?.env?.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
      ).toBeUndefined()
    } finally {
      handle.kill()
    }
  })
})

function anthropicConfiguration(): ProviderConfigurationV2 {
  return {
    version: 2,
    revision: 5,
    defaultModel: null,
    providers: [
      {
        id: 'kimi',
        displayName: 'Kimi',
        kind: 'anthropic',
        baseUrl: 'https://api.example.test/coding',
        auth: {
          scheme: 'api-key',
          source: 'settings',
          envName: 'ANTHROPIC_API_KEY',
        },
        enabled: true,
        archived: false,
        models: [
          {
            id: 'model-k',
            displayName: 'Model K',
            remoteModelId: 'remote-k',
            enabled: true,
            archived: false,
            validation: { status: 'valid' },
          },
        ],
      },
    ],
  }
}

function configuration(): ProviderConfigurationV2 {
  return {
    version: 2,
    revision: 5,
    defaultModel: {
      providerId: 'custom-openai',
      modelProfileId: 'model-b',
    },
    providers: [
      {
        id: 'custom-openai',
        displayName: 'Custom OpenAI',
        kind: 'openai-compatible',
        baseUrl: 'https://example.test/v1',
        auth: {
          scheme: 'api-key',
          source: 'environment',
          envName: 'CUSTOM_OPENAI_API_KEY',
        },
        compatRule: 'permissive',
        enabled: true,
        archived: false,
        models: [
          {
            id: 'model-b',
            displayName: 'Model B',
            remoteModelId: 'remote-b',
            enabled: true,
            archived: false,
            validation: { status: 'valid' },
          },
        ],
      },
    ],
  }
}

describe('bridge provider runtime recovery', () => {
  test('allows a stale revision only when the model identity is still exact', () => {
    const result = resolveBridgeProviderRuntime(
      configuration(),
      {
        providerId: 'custom-openai',
        modelProfileId: 'model-b',
        resolvedModelId: 'remote-b',
        providerConfigRevision: 4,
        updatedAt: 123,
      },
      {
        CUSTOM_OPENAI_API_KEY: 'secret-b',
        OPENAI_MODEL: 'global-model',
      },
      { isModelAllowed: () => true },
    )

    expect(result.stale).toBe(true)
    expect(result.snapshot.providerConfigRevision).toBe(5)
    expect(result.providerEnvironment.OPENAI_MODEL).toBe('remote-b')
    expect(result.providerEnvironment.OPENAI_API_KEY).toBe('secret-b')
  })

  test('rejects a stale selection whose remote model identity changed', () => {
    expect(() =>
      resolveBridgeProviderRuntime(
        configuration(),
        {
          providerId: 'custom-openai',
          modelProfileId: 'model-b',
          resolvedModelId: 'old-remote-b',
          providerConfigRevision: 4,
          updatedAt: 123,
        },
        { CUSTOM_OPENAI_API_KEY: 'secret-b' },
        { isModelAllowed: () => true },
      ),
    ).toThrow('resolved_model_mismatch')
  })
})

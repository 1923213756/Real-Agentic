import { describe, expect, test } from 'bun:test'
import {
  ProviderAuthService,
  sanitizeAuthErrorDetail,
  type ProviderAuthDependencies,
} from '../authService.js'
import type { OAuthTokens } from '../../oauth/types.js'

const tokens = {
  accessToken: 'private',
  refreshToken: 'private',
} as OAuthTokens

function dependencies() {
  let oauthOptions: Record<string, unknown> | undefined
  let resolveOAuth: ((tokens: OAuthTokens) => void) | undefined
  let resolveDevice: (() => void) | undefined
  const installed: string[] = []
  const deps: ProviderAuthDependencies = {
    createOAuth: () => ({
      startOAuthFlow: async (handler, options) => {
        oauthOptions = options
        await handler('https://auth.example/manual')
        return new Promise(resolve => {
          resolveOAuth = resolve
        })
      },
      handleManualAuthCodeInput: () => {},
      cleanup: () => {},
    }),
    installOAuth: async () => {
      installed.push('oauth')
    },
    requestChatGPTCode: async () => ({
      verificationUrl: 'https://auth.openai.test/device',
      userCode: 'ABCD-EFGH',
      deviceAuthId: 'private-device-code',
      intervalSeconds: 3,
    }),
    completeChatGPTLogin: async () =>
      new Promise<void>(resolve => {
        resolveDevice = resolve
      }),
    importChatGPTAuth: async () => true,
    saveProviderSettings: async kind => {
      installed.push(kind)
    },
    removeChatGPT: async () => {},
    refreshCloud: async () => {},
    now: () => 100,
  }
  return {
    deps,
    installed,
    oauthOptions: () => oauthOptions,
    finishOAuth: () => resolveOAuth?.(tokens),
    finishDevice: () => resolveDevice?.(),
  }
}

describe('ProviderAuthService', () => {
  test('runs subscription and console OAuth without exposing tokens', async () => {
    for (const [method, loginWithClaudeAi] of [
      ['claude-subscription-oauth', true],
      ['anthropic-console-oauth', false],
    ] as const) {
      const fixture = dependencies()
      const service = new ProviderAuthService(fixture.deps)
      service.begin({ operationId: method, providerId: 'anthropic', method })
      await Promise.resolve()
      expect(service.get(method)).toMatchObject({
        state: 'waiting',
        authorizationUrl: 'https://auth.example/manual',
      })
      expect(fixture.oauthOptions()).toMatchObject({
        loginWithClaudeAi,
        skipBrowserOpen: true,
      })
      expect(JSON.stringify(service.get(method))).not.toContain('private')
      fixture.finishOAuth()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(service.get(method).state).toBe('succeeded')
    }
  })

  test('keeps ChatGPT device code private and exposes only user instructions', async () => {
    const fixture = dependencies()
    const service = new ProviderAuthService(fixture.deps)
    service.begin({
      operationId: 'chatgpt-login',
      providerId: 'chatgpt',
      method: 'chatgpt-device-oauth',
    })
    await Promise.resolve()
    const status = service.get('chatgpt-login')
    expect(status).toMatchObject({
      state: 'waiting',
      userCode: 'ABCD-EFGH',
      pollIntervalMs: 3000,
    })
    expect(JSON.stringify(status)).not.toContain('private-device-code')
    fixture.finishDevice()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(service.get('chatgpt-login').state).toBe('succeeded')
  })

  test('imports an existing Codex ChatGPT login and persists provider settings', async () => {
    const fixture = dependencies()
    const service = new ProviderAuthService(fixture.deps)
    service.begin({
      operationId: 'chatgpt-import',
      providerId: 'chatgpt',
      method: 'chatgpt-import',
    })

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(service.get('chatgpt-import').state).toBe('succeeded')
    expect(fixture.installed).toEqual(['chatgpt'])
  })

  test('cancels operations and rejects browser-provided shell fields', async () => {
    const fixture = dependencies()
    const service = new ProviderAuthService(fixture.deps)
    service.begin({
      operationId: 'cancel-me',
      providerId: 'chatgpt',
      method: 'chatgpt-device-oauth',
    })
    expect(service.cancel('cancel-me').state).toBe('cancelled')
    await expect(
      service.refresh({
        method: 'aws-iam',
        action: 'aws-refresh',
        command: 'rm -rf /',
      }),
    ).rejects.toThrow('invalid_auth_refresh_request')
    await expect(
      service.refresh({ method: 'aws-iam', action: 'aws-refresh' }),
    ).resolves.toBeUndefined()
  })
})

describe('auth failure reporting', () => {
  test('carries the real transport failure through to the status', async () => {
    // A 403 from auth.openai.com (the Worker has no proxy) used to be reported
    // as a bare provider_auth_failed, indistinguishable from a rejected
    // account. Keep the coarse code, but no longer discard the reason.
    const fixture = dependencies()
    fixture.deps.requestChatGPTCode = async () => {
      throw new Error('ChatGPT auth request failed (403): blocked')
    }
    const service = new ProviderAuthService(fixture.deps)
    service.begin({
      operationId: 'chatgpt-403',
      providerId: 'chatgpt',
      method: 'chatgpt-device-oauth',
    })

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(service.get('chatgpt-403')).toMatchObject({
      state: 'failed',
      errorCode: 'provider_auth_failed',
    })
    expect(service.get('chatgpt-403').errorDetail).toContain('403')
  })

  test('redacts token-shaped text before it reaches the browser', () => {
    const jwt = `eyJ${'a'.repeat(40)}`
    const detail = sanitizeAuthErrorDetail(
      new Error(`token request failed: ${jwt} and rt.1.${'b'.repeat(30)}`),
    )
    expect(detail).not.toContain(jwt)
    expect(detail).not.toContain('rt.1.')
    expect(detail).toContain('[redacted]')
  })

  test('caps an oversized provider error body', () => {
    const detail = sanitizeAuthErrorDetail(new Error('x'.repeat(1000)))
    expect(detail!.length).toBeLessThanOrEqual(301)
  })

  test('still reports the import-unavailable code with its detail', async () => {
    const fixture = dependencies()
    fixture.deps.importChatGPTAuth = async () => false
    const service = new ProviderAuthService(fixture.deps)
    service.begin({
      operationId: 'import-missing',
      providerId: 'chatgpt',
      method: 'chatgpt-import',
    })

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(service.get('import-missing').errorCode).toBe(
      'chatgpt_auth_import_unavailable',
    )
  })
})

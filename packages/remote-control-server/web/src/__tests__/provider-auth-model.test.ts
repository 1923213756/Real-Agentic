import { describe, expect, test } from 'bun:test'
import {
  ProviderAuthModel,
  parseProviderAuthStatus,
} from '../lib/provider-auth-model'

describe('provider auth model', () => {
  test('exposes instructions but rejects private flow state', () => {
    const status = parseProviderAuthStatus({
      operationId: 'operation-1',
      state: 'waiting',
      authorizationUrl: 'https://auth.example/device',
      userCode: 'ABCD-EFGH',
      expiresAt: 123,
      pollIntervalMs: 3000,
    })
    expect(status.userCode).toBe('ABCD-EFGH')
    expect(() =>
      parseProviderAuthStatus({
        ...status,
        deviceAuthId: 'private-device-code',
      }),
    ).toThrow('provider_auth_status_contains_secret')
  })

  test('uses the worker polling interval and maps only public error codes', () => {
    const model = new ProviderAuthModel()
    model.status = {
      operationId: 'operation-2',
      state: 'failed',
      expiresAt: 123,
      pollIntervalMs: 4500,
      errorCode: 'provider_auth_failed',
    }
    expect(model.pollDelay()).toBe(4500)
    expect(model.errorText()).toContain('认证失败')
  })
})

describe('provider auth failure detail', () => {
  test('surfaces the redacted reason alongside the mapped copy', () => {
    // provider_auth_failed alone cannot distinguish "the Worker cannot reach
    // OpenAI" from "the account was rejected", which is exactly the ambiguity
    // that made a missing proxy look like a broken subscription.
    const model = new ProviderAuthModel()
    model.status = {
      operationId: 'operation-3',
      state: 'failed',
      expiresAt: 123,
      errorCode: 'provider_auth_failed',
      errorDetail: 'ChatGPT auth request failed (403)',
    }
    expect(model.errorText()).toContain('认证失败')
    expect(model.errorText()).toContain('403')
  })

  test('accepts errorDetail but still rejects a non-string one', () => {
    expect(
      parseProviderAuthStatus({
        operationId: 'operation-4',
        state: 'failed',
        expiresAt: 1,
        errorDetail: 'boom',
      }).errorDetail,
    ).toBe('boom')
    expect(() =>
      parseProviderAuthStatus({
        operationId: 'operation-4',
        state: 'failed',
        expiresAt: 1,
        errorDetail: { nested: true },
      }),
    ).toThrow('invalid_provider_auth_status')
  })

  test('applyValue parses a status collected from a pending command result', () => {
    const model = new ProviderAuthModel()
    const status = model.applyValue({
      operationId: 'operation-5',
      state: 'waiting',
      userCode: 'WXYZ-1234',
      expiresAt: 9,
    })
    expect(status.userCode).toBe('WXYZ-1234')
    expect(model.status).toBe(status)
  })
})

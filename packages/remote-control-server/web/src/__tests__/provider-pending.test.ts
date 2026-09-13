import { describe, expect, test } from 'bun:test'
import {
  awaitPendingProviderValue,
  resolveProviderResponse,
} from '../lib/provider-pending'
import type {
  ProviderCatalogResponse,
  ProviderOperationResponse,
} from '../types'

const catalogResponse = (
  extra: Partial<ProviderCatalogResponse>,
): ProviderCatalogResponse => ({
  catalog: {
    providers: [],
    defaultModel: null,
    features: {
      catalogWrite: true,
      runtimeSwitch: true,
      secretControl: true,
      sessionPersistence: true,
    },
  } as unknown as ProviderCatalogResponse['catalog'],
  stale: false,
  ...extra,
})

const authStatus = {
  operationId: 'op-1',
  state: 'waiting',
  userCode: 'ABCD-EFGH',
  expiresAt: 1,
}

describe('awaitPendingProviderValue', () => {
  test('returns the value the write already answered with', async () => {
    let calls = 0
    const value = await awaitPendingProviderValue(
      'env-1',
      'op-1',
      catalogResponse({ value: authStatus }),
      async () => {
        calls += 1
        return {} as ProviderOperationResponse
      },
      1,
    )
    expect(value).toEqual(authStatus)
    expect(calls).toBe(0)
  })

  test('collects the durable result when the write came back 202 pending', async () => {
    // A Worker slower than the server's ~1.5s window returns 202 with only
    // operation_id. Reading `value` off that body is what made a healthy
    // ChatGPT device flow report invalid_provider_auth_status and never show
    // the verification code.
    const statuses: ProviderOperationResponse[] = [
      { status: 'pending', operation_id: 'op-1' },
      {
        status: 'completed',
        operation_id: 'op-1',
        result: { value: authStatus },
      },
    ]
    const value = await awaitPendingProviderValue(
      'env-1',
      'op-1',
      catalogResponse({ operation_id: 'op-1' }),
      async () => statuses.shift()!,
      1,
    )
    expect(value).toEqual(authStatus)
  })

  test('prefers the operation id the server handed back', async () => {
    const seen: string[] = []
    await awaitPendingProviderValue(
      'env-1',
      'browser-id',
      catalogResponse({ operation_id: 'queue-id' }),
      async (_environmentId, operationId) => {
        seen.push(operationId)
        return {
          status: 'completed',
          operation_id: operationId,
          result: { value: authStatus },
        }
      },
      1,
    )
    expect(seen).toEqual(['queue-id'])
  })

  test('surfaces the Worker error code when the pending command failed', async () => {
    await expect(
      awaitPendingProviderValue(
        'env-1',
        'op-1',
        catalogResponse({ operation_id: 'op-1' }),
        async () => ({
          status: 'completed',
          operation_id: 'op-1',
          result: { ok: false, errorCode: 'environment_offline' },
        }),
        1,
      ),
    ).rejects.toThrow('environment_offline')
  })

  test('gives up with a mappable code when the Worker never answers', async () => {
    await expect(
      awaitPendingProviderValue(
        'env-1',
        'op-1',
        catalogResponse({ operation_id: 'op-1' }),
        async () => ({ status: 'pending', operation_id: 'op-1' }),
        1,
      ),
    ).rejects.toThrow('provider_operation_pending_timeout')
  })
})

describe('resolveProviderResponse', () => {
  // The 202 body carries `error` + `catalog` + `operation_id` but no `stale`.
  // 202 is 2xx, so `api()` resolves instead of throwing, and every caller that
  // fed it to parseProviderCatalogResponse reported
  // invalid_provider_catalog_response for a command that was about to succeed.
  const pendingBody = {
    error: { type: 'provider_operation_pending' },
    catalog: { revision: 1 },
    operation_id: 'op-1',
  }

  test('passes a complete synchronous response through untouched', async () => {
    let calls = 0
    const response = catalogResponse({ value: authStatus })
    const resolved = await resolveProviderResponse(
      'env-1',
      'op-1',
      response,
      async () => {
        calls += 1
        return {} as ProviderOperationResponse
      },
      1,
    )
    expect(resolved).toBe(response)
    expect(calls).toBe(0)
  })

  test('resolves a 202 body into a catalog response shape', async () => {
    const statuses: ProviderOperationResponse[] = [
      { status: 'pending', operation_id: 'op-1' },
      {
        status: 'completed',
        operation_id: 'op-1',
        result: { catalog: { revision: 2 }, value: { models: [] } },
      } as unknown as ProviderOperationResponse,
    ]
    const resolved = await resolveProviderResponse(
      'env-1',
      null,
      pendingBody,
      async () => statuses.shift()!,
      1,
    )
    // `stale` is what parseProviderCatalogResponse requires; without it the
    // caller throws invalid_provider_catalog_response.
    expect(resolved).toEqual({
      catalog: { revision: 2 },
      stale: false,
      value: { models: [] },
    })
  })

  test('reads the operation id out of the pending body', async () => {
    const seen: string[] = []
    await resolveProviderResponse(
      'env-1',
      'browser-id',
      pendingBody,
      async (_environmentId, operationId) => {
        seen.push(operationId)
        return {
          status: 'completed',
          operation_id: operationId,
          result: { catalog: {} },
        } as unknown as ProviderOperationResponse
      },
      1,
    )
    expect(seen).toEqual(['op-1'])
  })

  test('surfaces the Worker error code for a failed pending command', async () => {
    await expect(
      resolveProviderResponse(
        'env-1',
        'op-1',
        pendingBody,
        async () =>
          ({
            status: 'completed',
            operation_id: 'op-1',
            result: { ok: false, errorCode: 'provider_not_found' },
          }) as unknown as ProviderOperationResponse,
        1,
      ),
    ).rejects.toThrow('provider_not_found')
  })
})

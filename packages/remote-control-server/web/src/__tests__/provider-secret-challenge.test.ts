import { describe, expect, test } from 'bun:test'
import { awaitSecretChallenge } from '../components/providers/ProviderAuthDialog'
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

const challenge = { operationId: 'op-1', algorithm: 'P256-HKDF-SHA256-AESGCM' }

describe('awaitSecretChallenge', () => {
  test('uses the challenge the handshake already returned', async () => {
    let calls = 0
    const value = await awaitSecretChallenge(
      'env-1',
      'op-1',
      catalogResponse({ value: challenge }),
      async () => {
        calls += 1
        return {} as ProviderOperationResponse
      },
      1,
    )
    expect(value).toEqual(challenge)
    expect(calls).toBe(0)
  })

  test('polls for the challenge when the handshake came back 202 pending', async () => {
    // A Worker that answers slower than the server's synchronous window
    // returns 202 with no `value`. Reading the challenge straight off that
    // body used to throw and abort the save before the submit request — the
    // credential never left the browser.
    const statuses: ProviderOperationResponse[] = [
      { status: 'pending', operation_id: 'op-1' },
      {
        status: 'completed',
        operation_id: 'op-1',
        result: { value: challenge },
      },
    ]
    const value = await awaitSecretChallenge(
      'env-1',
      'op-1',
      catalogResponse({ operation_id: 'op-1' }),
      async () => statuses.shift()!,
      1,
    )
    expect(value).toEqual(challenge)
  })

  test('surfaces the Worker error code when the pending command failed', async () => {
    await expect(
      awaitSecretChallenge(
        'env-1',
        'op-1',
        catalogResponse({ operation_id: 'op-1' }),
        async () => ({
          status: 'completed',
          operation_id: 'op-1',
          result: {
            ok: false,
            errorCode: 'provider_secret_method_unsupported',
          },
        }),
        1,
      ),
    ).rejects.toThrow('provider_secret_method_unsupported')
  })
})

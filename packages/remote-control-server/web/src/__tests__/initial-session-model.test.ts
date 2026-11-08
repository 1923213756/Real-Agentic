import { describe, expect, test } from 'bun:test'
import { applyInitialSessionModel } from '../lib/initial-session-model'
import type { ProviderModelCatalog } from '../types'

const selection = { providerId: 'p', modelProfileId: 'm' }
function catalog(revision = 1): ProviderModelCatalog {
  return {
    version: 1,
    revision,
    defaultModel: null,
    features: {
      runtimeSwitch: true,
      catalogWrite: true,
      sessionPersistence: true,
      secretControl: true,
    },
    providers: [
      {
        id: 'p',
        displayName: 'Provider',
        kind: 'anthropic-compatible',
        enabled: true,
        archived: false,
        auth: { scheme: 'api-key', source: 'settings', configured: true },
        models: [
          {
            id: 'm',
            displayName: 'Chosen',
            remoteModelId: 'remote-model',
            enabled: true,
            archived: false,
            validation: { status: 'valid' },
          },
        ],
      },
    ],
  }
}

describe('initial session model', () => {
  test('waits for activation before allowing the first message', async () => {
    const calls: string[] = []
    let confirm!: () => void
    const confirmed = new Promise<void>(resolve => {
      confirm = resolve
    })
    const started = applyInitialSessionModel(
      selection,
      async () => catalog(),
      async input => {
        expect(input).toEqual({ ...selection, providerConfigRevision: 1 })
        calls.push('switch')
        await confirmed
        return { ok: true }
      },
    ).then(() => {
      calls.push('send')
    })
    await Bun.sleep(0)
    expect(calls).toEqual(['switch'])
    confirm()
    await started
    expect(calls).toEqual(['switch', 'send'])
  })

  test('refreshes a stale catalog revision and rejects failed or deferred activation', async () => {
    let revision = 0
    await applyInitialSessionModel(
      selection,
      async () => catalog(++revision),
      async input =>
        input.providerConfigRevision === 1
          ? { ok: false, error: 'revision_conflict' }
          : { ok: true },
    )
    expect(revision).toBe(2)
    await expect(
      applyInitialSessionModel(
        selection,
        async () => catalog(),
        async () => ({ ok: false, error: 'authentication_required' }),
      ),
    ).rejects.toThrow('authentication_required')
    await expect(
      applyInitialSessionModel(
        selection,
        async () => catalog(),
        async () => ({ ok: true, data: { deferred: true } }),
      ),
    ).rejects.toThrow('尚未完成')
    const invalid = catalog()
    invalid.providers[0]!.models[0]!.validation = { status: 'invalid' }
    await expect(
      applyInitialSessionModel(
        selection,
        async () => invalid,
        async () => {
          throw new Error('must not activate')
        },
      ),
    ).rejects.toThrow('不可用')
  })
})

import { describe, expect, test } from 'bun:test'
import {
  readEnvironmentProviderCatalog,
  resolveDefaultSessionModel,
} from '../services/provider-catalog'

function capability(
  defaultModel: { providerId: string; modelProfileId: string } | null = {
    providerId: 'custom-openai',
    modelProfileId: 'model-a',
  },
) {
  return {
    version: 1,
    revision: 4,
    defaultModel,
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
          configured: true,
        },
        compatRule: 'permissive',
        enabled: true,
        archived: false,
        models: [
          {
            id: 'model-a',
            displayName: 'Model A',
            remoteModelId: 'remote-a',
            enabled: true,
            archived: false,
            validation: { status: 'valid' },
          },
        ],
      },
    ],
    features: {
      catalogWrite: false,
      sessionPersistence: false,
      runtimeSwitch: false,
      secretControl: false,
    },
  }
}

describe('environment provider catalog', () => {
  test('strictly parses the redacted v1 capability', () => {
    const result = readEnvironmentProviderCatalog({
      provider_model_catalog_v1: capability(),
    })

    expect(result).toMatchObject({
      supported: true,
      catalog: { revision: 4 },
    })
  })

  test('carries the detected marker through to the browser', () => {
    // parseProvider is an allowlist: an unrecognized key drops the whole
    // provider and the catalog degrades to unsupported. The marker therefore
    // has to be parsed here, not merely emitted by the runner.
    const value = capability()
    value.providers[0] = { ...value.providers[0]!, detected: true } as never

    const result = readEnvironmentProviderCatalog({
      provider_model_catalog_v1: value,
    })

    expect(result.supported).toBe(true)
    expect(
      result.supported ? result.catalog.providers[0]?.detected : undefined,
    ).toBe(true)
  })

  test('omits the detected marker for catalog-backed providers', () => {
    const result = readEnvironmentProviderCatalog({
      provider_model_catalog_v1: capability(),
    })

    expect(result.supported).toBe(true)
    expect(
      result.supported ? result.catalog.providers[0]?.detected : 'unset',
    ).toBeUndefined()
  })

  test('rejects a non-boolean detected marker', () => {
    const value = capability()
    value.providers[0] = { ...value.providers[0]!, detected: 'yes' } as never

    expect(
      readEnvironmentProviderCatalog({ provider_model_catalog_v1: value })
        .supported,
    ).toBe(false)
  })

  test('treats missing, old, and secret-bearing capabilities as unsupported', () => {
    expect(readEnvironmentProviderCatalog(null)).toEqual({
      supported: false,
      reason: 'missing',
    })
    expect(
      readEnvironmentProviderCatalog({
        provider_model_catalog_v1: { ...capability(), version: 2 },
      }),
    ).toEqual({ supported: false, reason: 'unsupported_version' })
    const unsafe = capability()
    const auth = unsafe.providers[0]!.auth as Record<string, unknown>
    auth.apiKey = 'must-not-cross-the-wire'
    expect(
      readEnvironmentProviderCatalog({
        provider_model_catalog_v1: unsafe,
      }),
    ).toEqual({ supported: false, reason: 'invalid' })
  })

  test('copies the exact environment default into a session selection', () => {
    expect(
      resolveDefaultSessionModel({
        capabilities: { provider_model_catalog_v1: capability() },
      }),
    ).toMatchObject({
      providerId: 'custom-openai',
      modelProfileId: 'model-a',
      resolvedModelId: 'remote-a',
      providerConfigRevision: 4,
    })
    expect(
      resolveDefaultSessionModel({
        capabilities: {
          provider_model_catalog_v1: capability(null),
        },
      }),
    ).toBeNull()
  })

  test('does not guess when the default reference is unavailable', () => {
    const value = capability()
    value.providers[0]!.models[0]!.archived = true

    expect(
      resolveDefaultSessionModel({
        capabilities: { provider_model_catalog_v1: value },
      }),
    ).toBeNull()
  })
})

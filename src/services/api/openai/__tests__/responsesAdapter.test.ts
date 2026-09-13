import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  buildResponsesRequest,
  createChatGPTResponsesStream,
  extractUsage,
} from '../responsesAdapter.js'
import { formatOpenAIPromptCacheKey } from '../openaiShared.js'
import { getProxyFetchOptions } from '../../../../utils/proxy.js'
import { calculateCacheHitRate } from '../../../../utils/cacheWarning.js'

describe('buildResponsesRequest', () => {
  const promptCacheKey = formatOpenAIPromptCacheKey('session-abc-123')

  test('includes max reasoning effort for ChatGPT Responses requests', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      reasoningEffort: 'max',
      promptCacheKey,
    })

    expect(request.reasoning).toEqual({ effort: 'max' })
  })

  test('includes reasoning effort for ChatGPT Responses requests', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      reasoningEffort: 'xhigh',
      promptCacheKey,
    })

    expect(request.reasoning).toEqual({ effort: 'xhigh' })
  })

  test('does not include unsupported max_output_tokens parameter', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      promptCacheKey,
    }) as Record<string, unknown>

    expect('max_output_tokens' in request).toBe(false)
  })

  test('includes stable prompt_cache_key for session-sticky cache routing', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      promptCacheKey,
    })

    expect(request.prompt_cache_key).toBe('ccb:session-abc-123')
  })

  test('prompt_cache_key is stable across turns (not derived from messages)', () => {
    const key = formatOpenAIPromptCacheKey('same-session')
    const turn1 = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'first' }],
      tools: [],
      toolChoice: undefined,
      promptCacheKey: key,
    })
    const turn2 = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' },
      ],
      tools: [],
      toolChoice: undefined,
      promptCacheKey: key,
    })

    expect(turn1.prompt_cache_key).toBe(turn2.prompt_cache_key)
    expect(turn1.prompt_cache_key).toBe('ccb:same-session')
  })
})

describe('extractUsage (OpenAI Responses → Anthropic usage)', () => {
  test('subtracts cached_tokens so hit rate uses OpenAI total as denominator', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 30_000,
        output_tokens: 100,
        input_tokens_details: { cached_tokens: 20_000 },
      },
    })

    expect(usage).toEqual({
      input_tokens: 10_000,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 20_000,
    })

    // Was 40% under the double-count bug; correct is 66.7%.
    const hitRate = calculateCacheHitRate(usage)
    expect(hitRate).toBeCloseTo((20_000 / 30_000) * 100, 5)
  })

  test('full cache hit can report 100% (not capped at 50%)', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 30_000,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 30_000 },
      },
    })

    expect(usage.input_tokens).toBe(0)
    expect(usage.cache_read_input_tokens).toBe(30_000)
    expect(calculateCacheHitRate(usage)).toBe(100)
  })

  test('maps cache_write_tokens to cache_creation without double-counting total', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 10_000,
        output_tokens: 10,
        input_tokens_details: {
          cached_tokens: 6_000,
          cache_write_tokens: 2_000,
        },
      },
    })

    expect(usage).toEqual({
      input_tokens: 2_000,
      output_tokens: 10,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 6_000,
    })
    // segments sum to OpenAI total
    expect(
      usage.input_tokens +
        usage.cache_creation_input_tokens +
        usage.cache_read_input_tokens,
    ).toBe(10_000)
    expect(calculateCacheHitRate(usage)).toBeCloseTo(60, 5)
  })

  test('clamps overlapping write/read that exceed total input', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 5_000,
        output_tokens: 0,
        input_tokens_details: {
          cached_tokens: 4_000,
          cache_write_tokens: 4_000,
        },
      },
    })

    expect(
      usage.input_tokens +
        usage.cache_creation_input_tokens +
        usage.cache_read_input_tokens,
    ).toBe(5_000)
    expect(usage.cache_read_input_tokens).toBe(4_000)
    expect(usage.cache_creation_input_tokens).toBe(1_000)
    expect(usage.input_tokens).toBe(0)
  })
})

describe('createChatGPTResponsesStream transport', () => {
  // getProxyUrl() falls back through all four spellings, so a developer shell
  // that exports only HTTP_PROXY still counts as "proxied" — clear them all.
  const PROXY_KEYS = [
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
  ] as const
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of PROXY_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of PROXY_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  async function capture(): Promise<Record<string, unknown>> {
    let init: Record<string, unknown> | undefined
    const fetchOverride = (async (_url: unknown, options: unknown) => {
      init = options as Record<string, unknown>
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch

    await createChatGPTResponsesStream({
      request: buildResponsesRequest({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        toolChoice: undefined,
        promptCacheKey: formatOpenAIPromptCacheKey('session-proxy'),
      }),
      signal: new AbortController().signal,
      fetchOverride,
    })
    return init ?? {}
  }

  test('hands the shared proxy options to the Codex backend request', async () => {
    // The API-key OpenAI client already goes through utils/proxy; this path
    // used a bare fetch, so on a network that can only reach OpenAI through a
    // proxy the subscription provider could not send a single request. The
    // invariant is that whatever utils/proxy resolves actually reaches fetch —
    // asserted against the helper itself so a sibling suite that stubs it
    // process-globally cannot turn this into a false positive.
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
    const expected = getProxyFetchOptions({ forAnthropicAPI: false }) as Record<
      string,
      unknown
    >

    const init = await capture()

    for (const [key, value] of Object.entries(expected)) {
      expect(init[key]).toEqual(value)
    }
    expect(init.method).toBe('POST')
  })

  test('still sends the request when the host has no proxy configured', async () => {
    const init = await capture()

    expect(init.proxy).toBeUndefined()
    expect(init.method).toBe('POST')
  })
})

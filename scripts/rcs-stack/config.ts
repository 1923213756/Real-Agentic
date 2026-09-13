export type StackMode = 'local' | 'dev'

export interface StackConfig {
  mode: StackMode
  host: string
  port: number
  healthUrl: string
  readyUrl: string
  webUrl: string
  rcsEnv: Record<string, string>
  workerEnv: Record<string, string>
  apiKeyCount: number
  publicSummary: {
    mode: StackMode
    rcsUrl: string
    webUrl: string
    apiKeyCount: number
    apiKeySource: 'generated' | 'environment'
  }
}

/** Loopback hosts that must never be routed through an outbound proxy. */
const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1']

/**
 * Outbound proxy configuration for the RCS children.
 *
 * The stack inherits process.env, so an exported HTTPS_PROXY already reached
 * the worker — but only if the shell that launched `bun run rcs` happened to
 * have one. When it did not, every provider that lives outside the local
 * network silently failed: the ChatGPT subscription flow got a 403 from
 * auth.openai.com and the Codex backend was unreachable, while local providers
 * kept working, so it read as "ChatGPT auth is broken" rather than "the worker
 * has no proxy". RCS_HTTPS_PROXY/RCS_HTTP_PROXY make it configurable without
 * depending on the launching shell.
 *
 * Both cases normalize the result into the child env: upper and lower case are
 * both set (Bun, undici, curl and utils/proxy.ts disagree on which they read),
 * and loopback is always appended to NO_PROXY so the worker's own control-lane
 * calls to the local RCS never take the proxy detour.
 */
export function resolveProxyEnv(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const httpsProxy = (
    env.RCS_HTTPS_PROXY ??
    env.HTTPS_PROXY ??
    env.https_proxy ??
    ''
  ).trim()
  const httpProxy = (
    env.RCS_HTTP_PROXY ??
    env.HTTP_PROXY ??
    env.http_proxy ??
    ''
  ).trim()
  if (!httpsProxy && !httpProxy) return {}

  const configured = (env.RCS_NO_PROXY ?? env.NO_PROXY ?? env.no_proxy ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
  const noProxy = [
    ...configured,
    ...LOOPBACK_NO_PROXY.filter(host => !configured.includes(host)),
  ].join(',')

  return {
    ...(httpsProxy ? { HTTPS_PROXY: httpsProxy, https_proxy: httpsProxy } : {}),
    ...(httpProxy ? { HTTP_PROXY: httpProxy, http_proxy: httpProxy } : {}),
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  }
}

export function resolveStackConfig(
  mode: StackMode,
  env: NodeJS.ProcessEnv,
  randomSecret: () => string = () => randomBytes(32).toString('base64url'),
): StackConfig {
  const host = env.RCS_HOST?.trim() || '127.0.0.1'
  const port = Number(env.RCS_PORT || '3000')
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `RCS_PORT must be an integer between 1 and 65535: ${env.RCS_PORT}`,
    )
  }

  const apiKeySource =
    env.RCS_API_KEYS === undefined ? 'generated' : 'environment'
  const apiKeys =
    env.RCS_API_KEYS === undefined
      ? [randomSecret()]
      : env.RCS_API_KEYS.split(',')
          .map(value => value.trim())
          .filter(Boolean)
  if (apiKeys.length === 0) {
    throw new Error('RCS_API_KEYS must contain at least one non-empty key')
  }

  const connectHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  const localBaseUrl = `http://${connectHost}:${port}`
  const bridgeBaseUrl = env.CLAUDE_BRIDGE_BASE_URL || localBaseUrl
  // Resident-child cap. Idle children above it are evicted rather than
  // blocking new sessions, so this sizes a warm-process cache, not the number
  // of conversations the worker can serve. Keep in step with the fallback in
  // scripts/rcs-worker.ts — this value is always injected, so it wins.
  const workerCapacity =
    env.CLAUDE_BRIDGE_MAX_RESIDENT || env.CLAUDE_BRIDGE_MAX_SESSIONS || '16'
  /** Concurrent-turn cap: the CPU and model-API bound. */
  const workerBusyCapacity = env.CLAUDE_BRIDGE_MAX_BUSY || '8'
  const webUrl =
    mode === 'dev' ? 'http://127.0.0.1:5173/code/' : `${localBaseUrl}/code/`
  const proxyEnv = resolveProxyEnv(env)

  return {
    mode,
    host,
    port,
    healthUrl: `${localBaseUrl}/health`,
    readyUrl: `${localBaseUrl}/ready`,
    webUrl,
    rcsEnv: {
      ...proxyEnv,
      RCS_API_KEYS: apiKeys.join(','),
      RCS_HOST: host,
      RCS_PORT: String(port),
      RCS_SINGLE_USER: env.RCS_SINGLE_USER ?? '1',
    },
    workerEnv: {
      ...proxyEnv,
      CLAUDE_BRIDGE_BASE_URL: bridgeBaseUrl,
      CLAUDE_BRIDGE_OAUTH_TOKEN: apiKeys[0]!,
      CLAUDE_BRIDGE_MAX_SESSIONS: workerCapacity,
      CLAUDE_BRIDGE_MAX_BUSY: workerBusyCapacity,
      CLAUDE_BRIDGE_SPAWN_MODE: env.CLAUDE_BRIDGE_SPAWN_MODE || 'same-dir',
      CLAUDE_BRIDGE_CREATE_SESSION_ON_START: '0',
      CLAUDE_BRIDGE_SESSION_INGRESS_URL:
        env.CLAUDE_BRIDGE_SESSION_INGRESS_URL || bridgeBaseUrl,
    },
    apiKeyCount: apiKeys.length,
    publicSummary: {
      mode,
      rcsUrl: localBaseUrl,
      webUrl,
      apiKeyCount: apiKeys.length,
      apiKeySource,
    },
  }
}

export function needsProductionWebBuild(
  mode: StackMode,
  distExists: boolean,
): boolean {
  return mode === 'local' && !distExists
}
import { randomBytes } from 'node:crypto'

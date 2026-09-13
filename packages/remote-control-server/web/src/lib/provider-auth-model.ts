import type { ProviderCatalogResponse } from '../types'

export type BrowserProviderAuthStatus = {
  operationId: string
  state:
    | 'starting'
    | 'waiting'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'expired'
  authorizationUrl?: string
  userCode?: string
  expiresAt: number
  pollIntervalMs?: number
  errorCode?: string
  /** Redacted underlying reason; `errorCode` alone is too coarse to act on. */
  errorDetail?: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function parseProviderAuthStatus(
  value: unknown,
): BrowserProviderAuthStatus {
  const status = record(value)
  const states = new Set([
    'starting',
    'waiting',
    'succeeded',
    'failed',
    'cancelled',
    'expired',
  ])
  if (
    !status ||
    typeof status.operationId !== 'string' ||
    typeof status.state !== 'string' ||
    !states.has(status.state) ||
    !Number.isSafeInteger(status.expiresAt) ||
    (status.authorizationUrl !== undefined &&
      typeof status.authorizationUrl !== 'string') ||
    (status.userCode !== undefined && typeof status.userCode !== 'string') ||
    (status.errorCode !== undefined && typeof status.errorCode !== 'string') ||
    (status.errorDetail !== undefined && typeof status.errorDetail !== 'string')
  ) {
    throw new Error('invalid_provider_auth_status')
  }
  for (const forbidden of [
    'accessToken',
    'refreshToken',
    'deviceCode',
    'deviceAuthId',
  ]) {
    if (Object.hasOwn(status, forbidden))
      throw new Error('provider_auth_status_contains_secret')
  }
  return status as unknown as BrowserProviderAuthStatus
}

export function authStatusFromResponse(response: ProviderCatalogResponse) {
  return parseProviderAuthStatus(response.value)
}

export const PROVIDER_AUTH_ERROR_TEXT: Record<string, string> = {
  provider_auth_failed: '认证失败，请检查本地网络与账号状态。',
  chatgpt_auth_import_unavailable:
    '未找到可导入的 Codex ChatGPT 登录，请改用 Device Flow。',
  provider_auth_cancelled: '认证已取消。',
  provider_auth_operation_not_found: '认证操作已失效，请重新开始。',
  provider_secret_required: '此认证方式需要通过加密通道提交凭据。',
  provider_operation_pending_timeout:
    '本地 Worker 未在超时前响应，请确认它在线后重试。',
  environment_offline: '本地 Worker 不在线，无法发起认证。',
}

export class ProviderAuthModel {
  status: BrowserProviderAuthStatus | null = null

  apply(response: ProviderCatalogResponse): BrowserProviderAuthStatus {
    this.status = authStatusFromResponse(response)
    return this.status
  }

  /** Same as `apply` for a value collected from a pending command result. */
  applyValue(value: unknown): BrowserProviderAuthStatus {
    this.status = parseProviderAuthStatus(value)
    return this.status
  }

  pollDelay(): number {
    return Math.max(1000, this.status?.pollIntervalMs ?? 2000)
  }

  errorText(): string | null {
    const code = this.status?.errorCode
    if (!code) return null
    const text = PROVIDER_AUTH_ERROR_TEXT[code] ?? '认证未完成。'
    // The mapped copy is deliberately vague; the detail is what makes a
    // failure actionable (e.g. a 403 from auth.openai.com means the Worker
    // cannot reach OpenAI, not that the account was rejected).
    const detail = this.status?.errorDetail
    return detail ? `${text}（${detail}）` : text
  }
}

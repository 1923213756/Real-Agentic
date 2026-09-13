export type ProviderAuthMethod =
  | 'claude-subscription-oauth'
  | 'anthropic-console-oauth'
  | 'chatgpt-device-oauth'
  | 'chatgpt-import'
  | 'api-key'
  | 'bearer-token'
  | 'aws-iam'
  | 'gcp-adc'
  | 'azure-ad'
  | 'proxy'

export type ProviderAuthOperationState =
  | 'starting'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired'

export type ProviderAuthOperationStatus = {
  operationId: string
  state: ProviderAuthOperationState
  authorizationUrl?: string
  userCode?: string
  expiresAt: number
  pollIntervalMs?: number
  errorCode?: string
  /**
   * Redacted, human-readable reason behind `errorCode`.
   *
   * `errorCode` is a small closed set the UI maps to fixed copy, so every
   * transport-level failure collapsed into `provider_auth_failed` — a 403 from
   * auth.openai.com (no proxy on this host) was indistinguishable from a
   * rejected account, and the panel could only say "check your network and
   * account". This carries the underlying message so the cause is visible.
   */
  errorDetail?: string
}

export type ProviderCloudRefreshRequest =
  | { method: 'aws-iam'; action: 'aws-refresh' }
  | { method: 'gcp-adc'; action: 'gcp-refresh' }
  | { method: 'azure-ad'; action: 'azure-refresh' }
  | { method: 'proxy'; action: 'proxy-probe' }

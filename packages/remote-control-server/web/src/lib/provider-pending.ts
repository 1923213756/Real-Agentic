import { apiFetchProviderOperation } from '../api/client'
import type { ProviderCatalogResponse } from '../types'

const PENDING_POLL_INTERVAL_MS = 400
const PENDING_POLL_ATTEMPTS = 25

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Normalize a provider response that may have come back 202 pending.
 *
 * A 202 lands in the browser as a *resolved* fetch — 202 is 2xx, so `api()`
 * never throws — carrying `{ error, catalog, operation_id }` and, critically,
 * no `stale` field. `parseProviderCatalogResponse` requires `stale`, so every
 * caller that fed a raw response straight into it reported
 * `invalid_provider_catalog_response` for a command that was healthy and about
 * to succeed on the Worker.
 *
 * Returns a value shaped like the synchronous response so downstream parsing is
 * identical on both paths.
 */
export async function resolveProviderResponse(
  environmentId: string,
  operationId: string | null,
  response: unknown,
  fetchOperation: typeof apiFetchProviderOperation = apiFetchProviderOperation,
  pollIntervalMs = PENDING_POLL_INTERVAL_MS,
): Promise<unknown> {
  const body = record(response)
  // A complete synchronous response always carries `stale`.
  if (body === null || typeof body['stale'] === 'boolean') return response
  const pendingId =
    typeof body['operation_id'] === 'string'
      ? body['operation_id']
      : operationId
  if (pendingId === null) return response
  for (let attempt = 0; attempt < PENDING_POLL_ATTEMPTS; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    const operation = await fetchOperation(environmentId, pendingId)
    if (operation.status !== 'completed') continue
    const result = record(operation.result)
    if (result === null) break
    if (result['ok'] === false) {
      throw new Error(String(result['errorCode'] ?? 'provider_command_failed'))
    }
    return {
      catalog: result['catalog'],
      stale: false,
      ...(result['value'] === undefined ? {} : { value: result['value'] }),
    }
  }
  throw new Error('provider_operation_pending_timeout')
}

/**
 * Resolve the result value of a provider write that may have come back pending.
 *
 * Provider writes get a ~1.5s synchronous window on the server. A Worker that
 * answers slower makes the route return 202 with `operation_id` and **no
 * `value`** — the result only ever lands in the durable command record. Callers
 * that read `response.value` directly therefore blow up on exactly the runs
 * where the command is still perfectly healthy, and report a failure for an
 * operation that goes on to succeed on the Worker.
 *
 * Every caller of a provider write must funnel through this instead.
 */
export async function awaitPendingProviderValue(
  environmentId: string,
  operationId: string,
  response: ProviderCatalogResponse,
  fetchOperation: typeof apiFetchProviderOperation = apiFetchProviderOperation,
  pollIntervalMs = PENDING_POLL_INTERVAL_MS,
): Promise<unknown> {
  if (response.value !== undefined) return response.value
  const pendingId = response.operation_id ?? operationId
  for (let attempt = 0; attempt < PENDING_POLL_ATTEMPTS; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    const operation = await fetchOperation(environmentId, pendingId)
    if (operation.status !== 'completed') continue
    if (operation.result?.ok === false) {
      throw new Error(operation.result.errorCode ?? 'provider_command_failed')
    }
    if (operation.result?.value !== undefined) return operation.result.value
    break
  }
  throw new Error('provider_operation_pending_timeout')
}
